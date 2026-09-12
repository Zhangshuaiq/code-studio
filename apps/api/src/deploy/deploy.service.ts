import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Dirent } from "fs";
import { readdir, stat, writeFile } from "fs/promises";
import { join, resolve } from "path";
import Docker from "dockerode";
import { PrismaService } from "../prisma/prisma.service";
import { SandboxService } from "../sandbox/sandbox.service";
import { GitService } from "../git/git.service";
import { DeployTargetService } from "./deploy-target.service";
import { getRuntime, ProjectRuntime } from "../sandbox/language-runtime";
import { deployTemplate, DOCKERIGNORE } from "./dockerfiles";
import { K8sDriver } from "./k8s.driver";
import { RegistryService, RegistryConfig } from "./registry.service";
import {
  ArtifactServerConfig,
  ArtifactServerDriver,
} from "./artifact-server.driver";
import {
  ProjectAccessService,
  ProjectCapability,
} from "../project-access/project-access.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { DatasourceService, DatasourceConfig } from "../datasource/datasource.service";
import { diagnosticMessage } from "../common/redact-diagnostic";
import { dependencyPolicyRequiresProxy, resolveDependencyAccessPolicy } from "../common/dependency-access-policy";

// tar-fs 是 dockerode 的依赖，直接用来打 build context（可自定义忽略规则）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tarFs = require("tar-fs") as {
  pack: (
    dir: string,
    opts?: { ignore?: (name: string) => boolean },
  ) => NodeJS.ReadableStream;
};

const IGNORE_RE =
  /(^|\/)(node_modules|target|dist|build|\.git|\.venv|venv|__pycache__)(\/|$)|(^|\/)\.aider/;
const LOG_TAIL = 12000;

// 构建前置校验：每种 runtime 构建必需的关键文件（缺了就早失败给明确提示，而非 npm/pip 的晦涩报错）
const REQUIRED_FILES: Record<string, string[]> = {
  node: ["package.json", "server.js"],
  "react-vite": ["package.json", "index.html"],
  python: ["requirements.txt", "main.py"],
  java: ["pom.xml"],
};

@Injectable()
export class DeployService {
  private readonly logger = new Logger(DeployService.name);
  private get docker(): Docker {
    return this.sandbox.getDocker();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly sandbox: SandboxService,
    private readonly git: GitService,
    private readonly targets: DeployTargetService,
    private readonly registries: RegistryService,
    private readonly access: ProjectAccessService,
    private readonly workspaces: WorkspaceService,
    private readonly datasources: DatasourceService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 解析目标 → 返回操作用的 Docker 客户端 + 访问用的主机名。
   * null（本机）→ 本机 socket / localhost；docker-tcp → 按 host:port 连（本机或远程同一套代码）。
   */
  private async clientFor(
    userId: string,
    targetId?: string | null,
  ): Promise<{ docker: Docker; host: string; targetName: string }> {
    if (!targetId) {
      return {
        docker: this.docker,
        host: "localhost",
        targetName: "本机 Docker",
      };
    }
    const t = await this.targets.resolveConfig(userId, targetId);
    if (t.kind === "local-docker") {
      return {
        docker: this.docker,
        host: t.config.publicHost || "localhost",
        targetName: t.name,
      };
    }
    if (t.kind === "docker-tcp") {
      const cfg = t.config;
      const docker = new Docker({
        host: cfg.host,
        port: Number(cfg.port) || 2375,
        protocol: cfg.tls ? "https" : "http",
      });
      return { docker, host: cfg.host, targetName: t.name };
    }
    if (t.kind === "docker-ssh") {
      const cfg = t.config;
      // docker-modem 通过 ssh2 连上远程、跑 `docker system dial-stdio` 转发到远程 daemon。
      // 远程需：sshd 可达 + 有 docker CLI(≥18.09) + 该用户能访问 docker。容器发布端口在远程机上。
      const docker = new Docker({
        protocol: "ssh",
        host: cfg.host,
        port: Number(cfg.port) || 22,
        username: cfg.username,
        sshOptions: {
          privateKey: cfg.privateKey,
          ...(cfg.passphrase ? { passphrase: cfg.passphrase } : {}),
        },
      } as Docker.DockerOptions);
      return { docker, host: cfg.host, targetName: t.name };
    }
    throw new BadRequestException(
      `目标「${t.name}」(${t.kind}) 的部署驱动尚未接入`,
    );
  }

  /** 返回缺失的构建必需文件（相对路径），全在则空数组 */
  private async missingRequiredFiles(
    cwd: string,
    runtimeId: string,
  ): Promise<string[]> {
    const required = REQUIRED_FILES[runtimeId] ?? [];
    const missing: string[] = [];
    for (const f of required) {
      const ok = await stat(resolve(cwd, f))
        .then((s) => s.isFile())
        .catch(() => false);
      if (!ok) missing.push(f);
    }
    return missing;
  }

  private async project(
    userId: string,
    sessionId: string,
    capability: ProjectCapability = "read",
  ) {
    const session = await this.access.requireSession(
      userId,
      sessionId,
      capability,
    );
    const workspace = await this.workspaces.ensureForSession(userId, sessionId);
    return { ...session.project, volumePath: workspace.path };
  }

  /** 触发部署：按目标分发到 Docker、K8s 或普通服务器；后台异步执行。 */
  async deploy(
    userId: string,
    sessionId: string,
    targetId?: string,
    metadata?: {
      environment?: string;
      branch?: string;
      deployedByName?: string;
      sourcePath?: string;
      datasourceId?: string;
    },
  ) {
    const project = await this.project(userId, sessionId, "read");
    const runtime = getRuntime(project.language);
    const tpl = deployTemplate(runtime.id);
    if (!tpl)
      throw new BadRequestException({ code: 'DEPLOY_RUNTIME_UNSUPPORTED', message: `${runtime.displayName} 暂不支持部署` });

    const cwd = resolve(metadata?.sourcePath || project.volumePath);

    // 前置校验：关键文件缺失（生成不完整）就早失败，给出可操作提示，避免 npm/pip 晦涩报错
    const missing = await this.missingRequiredFiles(cwd, runtime.id);
    if (missing.length)
      throw new BadRequestException({ code: 'DEPLOY_REQUIRED_FILES_MISSING', message: `项目缺少构建必需文件：${missing.join("、")}。生成可能不完整，请重新生成后再部署。`, missing });

    // 部署目标必填（无内置项，全部由用户配置）
    if (!targetId) throw new BadRequestException({ code: 'DEPLOY_TARGET_REQUIRED', message: '请先配置并选择一个部署目标' });

    // 目标分发：k8s 走 apiserver 下发清单（构建在本机、集群拉取）；其余走 docker daemon
    const target = await this.targets.resolveConfig(userId, targetId);
    const targetName = target.name;
    if (!target.enabled) throw new BadRequestException({ code: 'DEPLOY_TARGET_DISABLED', message: '所选部署目标已停用' });
    if (!target.purposes.includes("deploy")) {
      throw new BadRequestException("所选运行资源未启用统一部署用途");
    }
    if (target.kind === "server-artifact" && runtime.id !== "java") {
      throw new BadRequestException(
        "产物直传服务器当前支持 Java Maven 项目的 JAR/WAR，请为其它项目选择 Docker 或 Kubernetes 目标",
      );
    }

    const branch =
      metadata?.branch ||
      (await this.git.currentBranch(cwd).catch(() => "")) ||
      "unknown";
    const actor =
      metadata?.deployedByName ||
      (await this.prisma.user
        .findUnique({
          where: { id: userId },
          select: { displayName: true, username: true },
        })
        .then((user) => user?.displayName || user?.username)
        .catch(() => undefined)) ||
      "unknown";
    const environment = metadata?.environment || "default";
    const datasource = metadata?.datasourceId
      ? await this.datasources.resolveForDeployment(userId, metadata.datasourceId, project.teamId)
      : undefined;

    await this.prisma.deployment.upsert({
      where: { projectId: project.id },
      create: {
        projectId: project.id,
        status: "building",
        logsTail: "",
        containerId:
          target.kind === "server-artifact" ? "artifact://pending" : null,
        targetId: targetId ?? null,
        targetName,
        datasourceId: datasource?.id,
        datasourceName: datasource?.name,
        environment,
        branch,
        deployedById: userId,
        deployedByName: actor,
      },
      update: {
        status: "building",
        logsTail: "",
        url: null,
        image: null,
        gitSha: null,
        containerId:
          target.kind === "server-artifact" ? "artifact://pending" : null,
        containerPort: null,
        hostPort: null,
        targetId: targetId ?? null,
        targetName,
        datasourceId: datasource?.id ?? null,
        datasourceName: datasource?.name ?? null,
        environment,
        branch,
        deployedById: userId,
        deployedByName: actor,
      },
    });

    const record = await this.prisma.deploymentRecord.create({
      data: {
        projectId: project.id,
        targetId: targetId ?? null,
        targetName,
        datasourceId: datasource?.id,
        datasourceName: datasource?.name,
        environment,
        branch,
        status: "building",
        deployedById: userId,
        deployedByName: actor,
      },
    });
    await this.prisma.deployment.update({
      where: { projectId: project.id },
      data: { activeRecordId: record.id },
    });

    if (target.kind === "server-artifact") {
      this.buildAndUploadArtifact(
        project.id,
        cwd,
        runtime,
        runtime.deploy!.buildCommand,
        target.config as ArtifactServerConfig,
      ).catch((err) =>
        this.fail(project.id, `产物部署失败: ${errorMessage(err)}`),
      );
    } else if (target.kind === "k8s") {
      const cfg = target.config;
      // 可插拔镜像仓库：k8s 目标填了 registryId 就解析出凭证（远程集群前提）；空则用集群本地/共享镜像库
      const registry: RegistryConfig | undefined = cfg.registryId
        ? await this.registries.resolveConfig(target.ownerId, cfg.registryId)
        : undefined;
      // 异步执行，不阻塞请求
      this.runK8s(
        project.id,
        cwd,
        tpl.dockerfile,
        tpl.port,
        cfg.kubeconfig,
        cfg.namespace || "default",
        cfg.baseDomain,
        registry,
        datasource,
        environment,
      ).catch((err) => this.fail(project.id, `部署异常: ${errorMessage(err)}`));
    } else {
      const { docker, host } = await this.clientFor(userId, targetId);
      this.buildAndRun(
        project.id,
        cwd,
        runtime.id,
        tpl.dockerfile,
        tpl.port,
        docker,
        host,
      ).catch((err) => this.fail(project.id, `部署异常: ${errorMessage(err)}`));
    }
    return { status: "building" };
  }

  async get(userId: string, sessionId: string) {
    const project = await this.project(userId, sessionId);
    const d = await this.prisma.deployment.findUnique({
      where: { projectId: project.id },
    });
    if (!d) return { status: "none" };

    // 普通服务器产物上传没有常驻容器可探活，成功记录直接返回远端文件位置。
    if (d.containerId?.startsWith("artifact://")) {
      const encodedPath = d.containerId.slice("artifact://".length);
      return {
        ...d,
        deploymentKind: "artifact",
        artifactPath:
          encodedPath && encodedPath !== "pending"
            ? decodeURIComponent(encodedPath)
            : null,
      };
    }

    // k8s 部署：走 apiserver 查状态（Pod 就绪/拉取失败/崩溃循环）
    if (
      d.containerId?.startsWith("k8s://") &&
      (d.status === "running" || d.status === "building")
    ) {
      const [namespace, name] = d.containerId.slice(6).split("/");
      const target = d.targetId
        ? await this.targets.resolveConfig(userId, d.targetId).catch(() => null)
        : null;
      if (!target) return { ...d };
      const st = await new K8sDriver(target.config.kubeconfig)
        .status(namespace, name)
        .catch(() => null);
      if (!st) return { ...d };
      if (d.status === "running" && st.phase === "failed") {
        await this.prisma.deployment
          .update({
            where: { projectId: project.id },
            data: {
              status: "failed",
              logsTail: `${st.message ?? "k8s 运行异常"}\n${st.logs ?? ""}`,
            },
          })
          .catch(() => undefined);
        await this.mirrorRecord(project.id);
        return { ...d, status: "failed", runtimeLogs: st.logs, runtimeEvents: st.events };
      }
      return { ...d, runtimeLogs: st.logs, runtimeEvents: st.events };
    }

    // 运行中的部署：实时查容器状态 + 抓运行日志，崩了就纠正为 failed
    let runtimeLogs: string | undefined;
    if (d.containerId && (d.status === "running" || d.status === "building")) {
      const { docker } = await this.clientFor(userId, d.targetId).catch(() => ({
        docker: this.docker,
      }));
      const info = await docker
        .getContainer(d.containerId)
        .inspect()
        .catch(() => null);
      runtimeLogs = await this.containerLogs(docker, d.containerId);
      const restarts = info?.RestartCount ?? 0;
      const crashed = info && !info.State?.Running && !info.State?.Restarting;
      if (d.status === "running" && info && (restarts > 0 || crashed)) {
        // 运行时崩溃 / crash-loop
        const reason = crashed
          ? `容器已退出（exit ${info.State?.ExitCode ?? "?"}）`
          : `容器崩溃重启 ${restarts} 次`;
        await this.prisma.deployment
          .update({
            where: { projectId: project.id },
            data: {
              status: "failed",
              logsTail: `${reason}。运行日志:\n${runtimeLogs}`,
            },
          })
          .catch(() => undefined);
        await this.mirrorRecord(project.id);
        return { ...d, status: "failed", runtimeLogs };
      }
    }
    return { ...d, runtimeLogs };
  }

  /** 只读部署快照：不创建工作区、不访问 Docker/Kubernetes、不回写状态。 */
  async readStatus(userId: string, sessionId: string) {
    const session = await this.access.requireSession(userId, sessionId, 'read');
    const deployment = await this.prisma.deployment.findUnique({
      where: { projectId: session.projectId },
    });
    if (!deployment) return {
      sessionId,
      projectId: session.projectId,
      status: 'none',
      observedFrom: 'database',
    };
    return {
      id: deployment.id,
      sessionId,
      projectId: session.projectId,
      targetId: deployment.targetId,
      targetName: deployment.targetName,
      datasourceId: deployment.datasourceId,
      datasourceName: deployment.datasourceName,
      environment: deployment.environment,
      branch: deployment.branch,
      deployedById: deployment.deployedById,
      deployedByName: deployment.deployedByName,
      gitSha: deployment.gitSha,
      image: deployment.image,
      status: deployment.status,
      url: deployment.url,
      createdAt: deployment.createdAt,
      updatedAt: deployment.updatedAt,
      observedFrom: 'database',
    };
  }

  async stop(userId: string, sessionId: string) {
    const session = await this.access.requireSession(userId, sessionId, 'read');
    return this.stopDeployment(userId, session.projectId);
  }

  /** 项目删除前调用；不创建发布会话，也不初始化代码工作区。 */
  async stopProject(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, 'manage');
    return this.stopDeployment(userId, projectId);
  }

  private async stopDeployment(userId: string, projectId: string) {
    const d = await this.prisma.deployment.findUnique({
      where: { projectId },
    });
    if (d?.containerId?.startsWith("artifact://")) {
      // 上传产物本身不是常驻进程；“停止”只结束平台侧状态，不删除远端文件。
    } else if (d?.containerId?.startsWith("k8s://")) {
      const [namespace, name] = d.containerId.slice(6).split("/");
      const target = d.targetId
        ? await this.targets.resolveConfig(userId, d.targetId)
        : null;
      if (!target) throw new BadRequestException('Kubernetes 部署缺少运行目标，无法确认资源已停止');
      await new K8sDriver(target.config.kubeconfig).remove(namespace, name);
    } else if (d?.containerId) {
      const { docker } = await this.clientFor(userId, d.targetId);
      await this.removeContainer(docker, d.containerId);
    }
    if (d) {
      await this.prisma.deployment.update({
        where: { projectId },
        data: { status: "stopped", url: null },
      });
      await this.mirrorRecord(projectId);
    }
    return { status: "stopped" };
  }

  // ---- 内部 ----

  /** 在项目沙箱中构建 Maven 产物，再经 SFTP 原子上传并按需执行重启命令。 */
  private async buildAndUploadArtifact(
    projectId: string,
    cwd: string,
    runtime: ProjectRuntime,
    buildCommand: string,
    config: ArtifactServerConfig,
  ): Promise<void> {
    const appendLog = this.deploymentLogger(projectId);
    await appendLog(`开始构建 Maven 产物\n$ ${buildCommand}\n`);

    const build = await this.sandbox.execInWorkspace(runtime, cwd, [
      "sh",
      "-c",
      buildCommand,
    ]);
    if (build.output.trim()) await appendLog(`${build.output.trim()}\n`);
    if (build.exitCode !== 0) {
      throw new Error(`构建命令退出码 ${build.exitCode}`);
    }

    const artifact = await findJavaArtifact(cwd);
    const sha = (await this.git.headSha(cwd)) || Date.now().toString();
    await appendLog(
      `构建完成：${artifact.name}（${formatBytes(artifact.size)}）\n` +
        `连接服务器：${config.username}@${config.host}:${Number(config.port) || 22}\n`,
    );

    let reportedBucket = -1;
    const driver = new ArtifactServerDriver(config);
    const uploaded = await driver.upload(
      artifact.path,
      (transferred, total) => {
        const percentage = total
          ? Math.min(100, Math.floor((transferred / total) * 100))
          : 0;
        const bucket = Math.floor(percentage / 10) * 10;
        if (bucket > reportedBucket) {
          reportedBucket = bucket;
          void appendLog(
            `上传进度：${percentage}%（${formatBytes(transferred)} / ${formatBytes(total)}）\n`,
          );
        }
      },
    );

    await appendLog(`上传完成：${uploaded.remoteFile}\n`);
    if (config.restartCmd?.trim()) {
      await appendLog(
        uploaded.restartOutput
          ? `重启命令执行成功：\n${uploaded.restartOutput}\n`
          : "重启命令执行成功\n",
      );
    }

    await this.prisma.deployment.update({
      where: { projectId },
      data: {
        status: "running",
        image: artifact.name,
        gitSha: sha,
        containerId: `artifact://${encodeURIComponent(uploaded.remoteFile)}`,
        url: null,
        containerPort: null,
        hostPort: null,
      },
    });
    await this.mirrorRecord(projectId);
    this.logger.log(
      `产物已上传 project=${projectId} remote=${uploaded.remoteFile}`,
    );
  }

  /** 串行写入部署日志，避免 SFTP 高频进度回调互相覆盖。 */
  private deploymentLogger(projectId: string) {
    let logs = "";
    let queue = Promise.resolve();
    return (message: string): Promise<void> => {
      logs = (logs + message).slice(-LOG_TAIL);
      const snapshot = logs;
      queue = queue.then(async () => {
        await this.prisma.deployment
          .update({ where: { projectId }, data: { logsTail: snapshot } })
          .catch(() => undefined);
        await this.mirrorRecord(projectId);
      });
      return queue;
    };
  }

  /**
   * 构建生产镜像（tar-fs 打 context → docker.buildImage → 流式日志落库）。
   * 返回镜像 tag 与 git sha；构建失败抛错（调用方负责标 failed）。
   * docker 参数决定「在哪台 daemon 上构建」：docker 路径用目标 daemon；k8s 路径用本机 daemon（镜像入本地库供集群拉取）。
   */
  private async buildImage(
    projectId: string,
    cwd: string,
    dockerfile: string,
    docker: Docker,
  ): Promise<{ tag: string; sha: string }> {
    await writeFile(join(cwd, "Dockerfile"), dockerfile, "utf8");
    await writeFile(join(cwd, ".dockerignore"), DOCKERIGNORE, "utf8");

    const sha = (await this.git.headSha(cwd)) || Date.now().toString();
    const tag = `codegen-deploy-${projectId.slice(0, 8)}:${sha.slice(0, 8)}`;

    let logs = "";
    const appendLog = async (s: string) => {
      logs = (logs + s).slice(-LOG_TAIL);
      await this.prisma.deployment
        .update({ where: { projectId }, data: { logsTail: logs } })
        .catch(() => undefined);
      await this.mirrorRecord(projectId);
    };

    const pack = tarFs.pack(cwd, { ignore: (name) => IGNORE_RE.test(name) });
    const useDependencyProxy = dependencyPolicyRequiresProxy(resolveDependencyAccessPolicy(
      this.config.get<string>('DEPENDENCY_ACCESS_POLICY'),
      this.config.get<string>('K8S_GENERATION_REQUIRE_DEPENDENCY_PROXY'),
    ));
    const stream = await docker.buildImage(pack as never, {
      t: tag,
      dockerfile: "Dockerfile",
      buildargs: {
        NPM_REGISTRY: useDependencyProxy ? this.config.get<string>('DEPENDENCY_NPM_REGISTRY', '') : '',
        PIP_INDEX_URL: useDependencyProxy ? this.config.get<string>('DEPENDENCY_PIP_INDEX_URL', '') : '',
      },
    });
    await new Promise<void>((res, rej) => {
      docker.modem.followProgress(
        stream,
        (err, out) => {
          if (err) return rej(err);
          const bad = (out || []).find((o: any) => o.error || o.errorDetail);
          if (bad) return rej(new Error(bad.error || bad.errorDetail?.message));
          res();
        },
        (evt: any) => {
          if (evt.stream) appendLog(evt.stream);
          else if (evt.status) appendLog(evt.status + "\n");
        },
      );
    });
    return { tag, sha };
  }

  private async buildAndRun(
    projectId: string,
    cwd: string,
    runtimeId: string,
    dockerfile: string,
    port: number,
    docker: Docker,
    host: string,
  ) {
    // 1) 构建镜像
    let tag: string, sha: string;
    try {
      ({ tag, sha } = await this.buildImage(
        projectId,
        cwd,
        dockerfile,
        docker,
      ));
    } catch (err) {
      return this.fail(
        projectId,
        `构建失败:\n${String((err as Error).message).slice(0, 2000)}`,
      );
    }

    // 2) 起容器（先清掉旧的）
    const name = `deploy-${projectId.slice(0, 12)}`;
    await this.removeContainerByName(docker, name);
    try {
      const container = await docker.createContainer({
        Image: tag,
        name,
        ExposedPorts: { [`${port}/tcp`]: {} },
        HostConfig: {
          PortBindings: { [`${port}/tcp`]: [{ HostPort: "" }] },
          RestartPolicy: { Name: "unless-stopped" },
          Memory: 512 * 1024 * 1024,
          NanoCpus: 1e9,
        },
      });
      await container.start();
      const info = await container.inspect();
      const hostPort =
        info.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0]?.HostPort;
      await this.prisma.deployment.update({
        where: { projectId },
        data: {
          image: tag,
          gitSha: sha,
          containerId: container.id,
          containerPort: port,
          hostPort: hostPort ? Number(hostPort) : null,
          url: hostPort ? `http://${host}:${hostPort}` : null,
        },
      });
      await this.mirrorRecord(projectId);

      // 就绪探测：崩溃/重启循环即失败并抓日志；HTTP 可达即健康
      const deadline = Date.now() + 60000;
      let healthy = false;
      while (Date.now() < deadline) {
        const st = await container.inspect().catch(() => null);
        if (!st) break;
        const restarts = st.RestartCount ?? 0;
        // 崩溃重启（unless-stopped 会拉起，所以靠 RestartCount 判断）
        if (restarts > 0) {
          const rlog = await this.containerLogs(docker, container.id);
          return this.fail(
            projectId,
            `容器启动后崩溃（已重启 ${restarts} 次）。运行日志:\n${rlog}`,
          );
        }
        // 直接退出且没在重启
        if (!st.State?.Running && !st.State?.Restarting) {
          const rlog = await this.containerLogs(docker, container.id);
          return this.fail(
            projectId,
            `容器已退出（exit ${st.State?.ExitCode ?? "?"}）。运行日志:\n${rlog}`,
          );
        }
        if (hostPort && (await this.probe(host, Number(hostPort)))) {
          healthy = true;
          break;
        }
        await sleep(2000);
      }

      await this.prisma.deployment.update({
        where: { projectId },
        data: { status: "running" },
      });
      await this.mirrorRecord(projectId);
      this.logger.log(
        `已部署 project=${projectId} url=http://${host}:${hostPort} healthy=${healthy}`,
      );
    } catch (err) {
      return this.fail(
        projectId,
        `启动容器失败: ${String((err as Error).message)}`,
      );
    }
  }

  /**
   * k8s 路径：本机构建镜像 → apiserver 下发 Deployment+Service(NodePort) → 轮询就绪。
   * containerId 存 `k8s://<ns>/<name>` 作标记，供 get/stop 识别并走 k8s 客户端。
   */
  private async runK8s(
    projectId: string,
    cwd: string,
    dockerfile: string,
    port: number,
    kubeconfig: string,
    namespace: string,
    baseDomain: string | undefined,
    registry?: RegistryConfig,
    datasource?: { id: string; name: string; type: string; config: DatasourceConfig },
    environment = 'default',
  ) {
    // 1) 本机构建镜像（进本地库）
    let tag: string, sha: string;
    try {
      ({ tag, sha } = await this.buildImage(
        projectId,
        cwd,
        dockerfile,
        this.docker,
      ));
    } catch (err) {
      return this.fail(
        projectId,
        `构建失败:\n${String((err as Error).message).slice(0, 2000)}`,
      );
    }

    const name = `codegen-${projectId.slice(0, 8)}`;
    const driver = new K8sDriver(kubeconfig);

    // 2) 插了 registry → 重打 tag + 推送 + 建拉取密钥；集群 image 用完整引用。
    //    没插 → 用本地镜像（仅当集群与构建机共享镜像库，如 Docker Desktop）。
    let image = tag;
    let imagePullSecrets: string[] | undefined;
    let secretEnvName: string | undefined;
    if (registry) {
      try {
        const repo = `${registry.url}/${registry.project || "codegen"}/codegen-${projectId.slice(0, 8)}`;
        image = `${repo}:${sha.slice(0, 8)}`;
        await this.pushImage(projectId, tag, repo, sha.slice(0, 8), registry);
        const secret = await driver.ensureImagePullSecret(
          namespace,
          `${name}-pull`,
          registry,
        );
        imagePullSecrets = [secret];
      } catch (err) {
        return this.fail(
          projectId,
          `推送镜像到仓库失败: ${String((err as Error).message).slice(0, 800)}`,
        );
      }
    }

    if (datasource) {
      secretEnvName = await driver.ensureOpaqueSecret(
        namespace,
        `${name}-database`,
        databaseEnvironment(datasource.type, datasource.config),
      );
    }

    // 3) 下发清单
    let nodePort: number, url: string;
    try {
      ({ nodePort, url } = await driver.apply({
        namespace,
        name,
        image,
        containerPort: port,
        baseDomain,
        env: {
          PORT: String(port),
          DEPLOYMENT_ENVIRONMENT: environment,
          OTEL_EXPORTER_OTLP_ENDPOINT: this.config.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://otel-collector.observability:4318'),
          OTEL_SERVICE_NAME: name,
          OTEL_RESOURCE_ATTRIBUTES: `codegen.project.id=${projectId}`,
        },
        imagePullSecrets,
        secretEnvName,
      }));
    } catch (err) {
      return this.fail(
        projectId,
        `下发 k8s 清单失败: ${String((err as Error).message).slice(0, 800)}`,
      );
    }

    await this.prisma.deployment.update({
      where: { projectId },
      data: {
        image,
        gitSha: sha,
        containerId: `k8s://${namespace}/${name}`,
        containerPort: port,
        hostPort: nodePort,
        url,
      },
    });
    await this.mirrorRecord(projectId);

    // 4) 轮询就绪：以 Kubernetes Ready/Available 为准；远程 NodePort 未必能由平台节点直接访问。
    const deadline = Date.now() + 120000;
    let healthy = false;
    let latestStatus: Awaited<ReturnType<K8sDriver["status"]>> | undefined;
    while (Date.now() < deadline) {
      const st = await driver.status(namespace, name);
      latestStatus = st;
      if (st.phase === "failed")
        return this.fail(
          projectId,
          `${st.message ?? "k8s 部署失败"}${st.logs ? `\nPod 日志:\n${st.logs}` : ""}`,
        );
      if (st.phase === "running") {
        healthy = true;
        break;
      }
      await sleep(3000);
    }

    if (!healthy) {
      return this.fail(
        projectId,
        `Kubernetes Deployment 在 120 秒内未就绪${latestStatus?.events ? `\n集群事件:\n${latestStatus.events}` : ""}`,
      );
    }

    await this.prisma.deployment.update({
      where: { projectId },
      data: { status: "running" },
    });
    await this.mirrorRecord(projectId);
    this.logger.log(
      `已部署(k8s) project=${projectId} url=${url} healthy=${healthy}`,
    );
  }

  /**
   * 重打 registry 前缀 tag 并推送（dockerode，走标准 Docker Registry v2；进度落库）。
   * registry-agnostic：Harbor / ACR / Docker Hub / registry:2 同一套。
   */
  private async pushImage(
    projectId: string,
    localTag: string,
    repo: string,
    tag: string,
    registry: RegistryConfig,
  ): Promise<void> {
    const docker = this.docker;
    await docker.getImage(localTag).tag({ repo, tag });
    const authconfig = {
      username: registry.username,
      password: registry.password,
      serveraddress: registry.url,
    };
    let logs = "";
    const appendLog = async (s: string) => {
      logs = (logs + s).slice(-LOG_TAIL);
      await this.prisma.deployment
        .update({ where: { projectId }, data: { logsTail: logs } })
        .catch(() => undefined);
      await this.mirrorRecord(projectId);
    };
    await appendLog(`推送镜像 → ${repo}:${tag}\n`);
    const image = docker.getImage(`${repo}:${tag}`);
    const stream = await image.push({ authconfig });
    await new Promise<void>((res, rej) => {
      docker.modem.followProgress(
        stream,
        (err, out) => {
          if (err) return rej(err);
          const bad = (out || []).find((o: any) => o.error || o.errorDetail);
          if (bad) return rej(new Error(bad.error || bad.errorDetail?.message));
          res();
        },
        (evt: any) => {
          if (evt.status)
            appendLog(
              `${evt.status}${evt.progress ? " " + evt.progress : ""}\n`,
            );
        },
      );
    });
    await appendLog("推送完成\n");
  }

  /** 探活：HTTP GET 目标主机端口，任何响应(含 404)都算服务起来了；连不上则否 */
  private async probe(host: string, hostPort: number): Promise<boolean> {
    const h = host === "localhost" ? "127.0.0.1" : host;
    try {
      await fetch(`http://${h}:${hostPort}/`, {
        signal: AbortSignal.timeout(3000),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 取容器运行时日志（stdout+stderr 尾部） */
  private async containerLogs(
    docker: Docker,
    containerId: string,
    tail = 200,
  ): Promise<string> {
    try {
      const buf = (await docker.getContainer(containerId).logs({
        stdout: true,
        stderr: true,
        tail,
        follow: false,
      })) as unknown as Buffer;
      return demuxDockerLog(buf).slice(-LOG_TAIL);
    } catch {
      return "";
    }
  }

  private async fail(projectId: string, msg: string) {
    this.logger.warn(`部署失败 project=${projectId}: ${msg.slice(0, 200)}`);
    const existing = await this.prisma.deployment
      .findUnique({ where: { projectId }, select: { logsTail: true } })
      .catch(() => null);
    const logs = `${existing?.logsTail ? `${existing.logsTail.trimEnd()}\n` : ""}${msg}`;
    await this.prisma.deployment
      .update({
        where: { projectId },
        data: {
          status: "failed",
          logsTail: logs.slice(-LOG_TAIL),
        },
      })
      .catch(() => undefined);
    await this.mirrorRecord(projectId);
  }

  /** 将兼容用的“当前部署”同步到本次不可变部署记录。 */
  private async mirrorRecord(projectId: string) {
    const current = await this.prisma.deployment
      .findUnique({ where: { projectId } })
      .catch(() => null);
    if (!current?.activeRecordId) return;
    await this.prisma.deploymentRecord
      .update({
        where: { id: current.activeRecordId },
        data: {
          targetId: current.targetId,
          targetName: current.targetName,
          gitSha: current.gitSha,
          status: current.status,
          url: current.url,
          logsTail: current.logsTail,
        },
      })
      .catch(() => undefined);
  }

  private async removeContainer(docker: Docker, id: string) {
    try {
      await docker.getContainer(id).remove({ force: true });
    } catch (error) {
      if (!isRuntimeNotFound(error)) throw error;
    }
  }

  private async removeContainerByName(docker: Docker, name: string) {
    try {
      const list = await docker.listContainers({
        all: true,
        filters: { name: [name] },
      });
      for (const c of list) await this.removeContainer(docker, c.Id);
    } catch {
      /* 忽略 */
    }
  }
}

function isRuntimeNotFound(error: unknown) {
  const value = error as { statusCode?: number; response?: { statusCode?: number } };
  return value?.statusCode === 404 || value?.response?.statusCode === 404;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Docker 日志流是多路复用的（每帧 8 字节头：类型 + 4字节长度），解出纯文本
function demuxDockerLog(buf: Buffer): string {
  if (!Buffer.isBuffer(buf)) return String(buf ?? "");
  let out = "";
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const size = buf.readUInt32BE(i + 4);
    // 非法帧（可能是无头的 TTY 日志）→ 直接当纯文本返回
    if (type > 2 || i + 8 + size > buf.length + 4) return buf.toString("utf8");
    out += buf.slice(i + 8, i + 8 + size).toString("utf8");
    i += 8 + size;
  }
  return out || buf.toString("utf8");
}

async function findJavaArtifact(cwd: string): Promise<{
  path: string;
  name: string;
  size: number;
}> {
  const outputDir = resolve(cwd, "target");
  const entries: Dirent[] = await readdir(outputDir, {
    withFileTypes: true,
  }).catch(() => [] as Dirent[]);
  const candidates = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /\.(jar|war)$/i.test(entry.name) &&
          !/(^original-|\.original$|-sources\.|-javadoc\.)/i.test(entry.name),
      )
      .map(async (entry) => {
        const path = resolve(outputDir, entry.name);
        const info = await stat(path);
        return {
          path,
          name: entry.name,
          size: info.size,
          modifiedAt: info.mtimeMs,
        };
      }),
  );
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const artifact = candidates[0];
  if (!artifact) {
    throw new Error(
      "构建完成但 target 目录中没有找到 JAR/WAR，请检查 pom.xml 的 packaging 和构建插件",
    );
  }
  return { path: artifact.path, name: artifact.name, size: artifact.size };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function errorMessage(error: unknown): string {
  return diagnosticMessage(error);
}

function databaseEnvironment(type: string, config: DatasourceConfig): Record<string, string> {
  const host = String(config.host || "");
  const port = String(config.port || (type === "mysql" ? 3306 : 5432));
  const database = String(config.database || "");
  const protocol = type === "postgresql" ? "postgresql" : "mysql";
  return {
    DB_TYPE: type,
    DB_HOST: host,
    DB_PORT: port,
    DB_NAME: database,
    DB_USERNAME: String(config.username || ""),
    DB_PASSWORD: String(config.password || ""),
    SPRING_DATASOURCE_URL: `jdbc:${protocol}://${host}:${port}/${database}`,
    SPRING_DATASOURCE_USERNAME: String(config.username || ""),
    SPRING_DATASOURCE_PASSWORD: String(config.password || ""),
  };
}
