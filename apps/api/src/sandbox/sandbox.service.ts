import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import Docker from "dockerode";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { PrismaService } from "../prisma/prisma.service";
import { configuredRuntime, getRuntime, ProjectRuntime, runtimeDependencyEnv } from "./language-runtime";
import { WorkspaceService } from "../workspace/workspace.service";
import { CryptoService } from "../crypto/crypto.service";

// tar-fs 是 dockerode 的依赖，用于把用户工作区同步到远程 Docker 容器。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tarFs = require("tar-fs") as {
  pack: (
    dir: string,
    opts?: { ignore?: (name: string) => boolean },
  ) => NodeJS.ReadableStream;
};

const SYNC_IGNORE =
  /(^|\/)(node_modules|target|dist|build|\.git|\.venv|venv|__pycache__)(\/|$)/;

export interface SandboxHandle {
  containerId: string;
  volumePath: string; // 宿主机项目目录（同时是 Agent 的 cwd）
  runtime: ProjectRuntime;
  docker: Docker;
  host: string;
  targetId: string | null;
  targetName: string;
  runtimeKind: string;
}

interface RuntimeTarget {
  id: string | null;
  name: string;
  kind: string;
  docker: Docker;
  host: string;
  remote: boolean;
  maxPreviewInstances: number | null;
  capacityCpu: number | null;
  capacityMemoryMb: number | null;
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

export interface EmulatorHandle {
  containerId: string;
  adbHost: string;
  adbPort: number;
  endpoint: string;
}

@Injectable()
export class SandboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SandboxService.name);
  private readonly docker: Docker;
  private readonly memoryBytes: number;
  private readonly nanoCpus: number;
  private readonly containerWorkdir = "/workspace";
  private readonly idleTimeoutMs: number;
  private readonly maxPerUser: number;
  private readonly maxPerProject: number;
  private readonly maxPerTeam: number;
  private readonly maxExecOutputBytes: number;
  private readonly pidsLimit: number;
  private readonly tmpfsBytes: number;
  private reaper?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly workspaces: WorkspaceService,
    private readonly crypto: CryptoService,
  ) {
    this.docker = new Docker({ socketPath: resolveDockerSocket() });
    // 默认限制：1GB 内存、1 CPU
    this.memoryBytes =
      Number(this.config.get("SANDBOX_MEMORY_MB", 1024)) * 1024 * 1024;
    this.nanoCpus = Number(this.config.get("SANDBOX_CPUS", 1)) * 1e9;
    this.idleTimeoutMs =
      Number(this.config.get("SANDBOX_IDLE_MINUTES", 30)) * 60 * 1000;
    this.maxPerUser = Number(this.config.get("PREVIEW_MAX_PER_USER", 2));
    this.maxPerProject = Number(this.config.get("PREVIEW_MAX_PER_PROJECT", 10));
    this.maxPerTeam = Number(this.config.get("PREVIEW_MAX_PER_TEAM", 30));
    this.maxExecOutputBytes = Number(
      this.config.get("SANDBOX_EXEC_MAX_OUTPUT_BYTES", 2 * 1024 * 1024),
    );
    this.pidsLimit = Number(this.config.get("SANDBOX_PIDS_LIMIT", 256));
    this.tmpfsBytes = Number(
      this.config.get("SANDBOX_TMPFS_BYTES", 512 * 1024 * 1024),
    );
  }

  /** 复用同一个 Docker 客户端（部署也走 API，与沙箱一致） */
  getDocker(): Docker {
    return this.docker;
  }

  async health() {
    const startedAt = Date.now();
    try {
      const info = await this.docker.info();
      return {
        available: true,
        latencyMs: Date.now() - startedAt,
        version: info.ServerVersion,
        containers: info.Containers,
        containersRunning: info.ContainersRunning,
        images: info.Images,
        cpus: info.NCPU,
        memoryBytes: info.MemTotal,
      };
    } catch (error) {
      return { available: false, latencyMs: Date.now() - startedAt, error: (error as Error).message };
    }
  }

  async onModuleInit() {
    try {
      await this.docker.ping();
      this.logger.log("Docker daemon 连接正常");
      this.reaper = setInterval(
        () => {
          this.reapIdleSandboxes().catch((err) =>
            this.logger.warn(`回收空闲沙箱失败: ${err}`),
          );
        },
        Math.min(5 * 60 * 1000, Math.max(60 * 1000, this.idleTimeoutMs / 2)),
      );
      this.reaper.unref();
    } catch {
      this.logger.warn(
        "Docker daemon 未就绪，沙箱功能不可用（请确认 Docker Desktop 已启动）",
      );
    }
  }

  onModuleDestroy() {
    if (this.reaper) clearInterval(this.reaper);
  }

  /** 确保 session 有一个运行中的沙箱容器，返回句柄 */
  async ensureSandbox(sessionId: string): Promise<SandboxHandle> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: true, sandbox: true },
    });
    if (!session) {
      throw new Error("会话不存在");
    }

    const declaredRuntime = getRuntime(session.project.language);
    const runtime = configuredRuntime(declaredRuntime, (key) =>
      this.config.get<string>(key),
    );
    const workspace = await this.workspaces.ensureForSession(
      session.userId,
      sessionId,
    );
    const volumePath = workspace.path;

    // 已有容器且仍存活 → 复用
    if (session.sandbox) {
      const target = await this.runtimeTarget(session.sandbox.targetId);
      const alive = await this.isContainerRunning(
        target.docker,
        session.sandbox.containerId,
      );
      if (alive) {
        await this.touch(session.sandbox.id);
        return {
          containerId: session.sandbox.containerId,
          volumePath,
          runtime,
          docker: target.docker,
          host: target.host,
          targetId: target.id,
          targetName: target.name,
          runtimeKind: target.kind,
        };
      }
      // 记录了但容器没了 → 清理记录后重建
      await this.prisma.sandboxInstance.delete({
        where: { id: session.sandbox.id },
      });
    }

    const target = await this.selectPreviewTarget(
      session.userId,
      session.project,
    );
    const reservation = await this.reserveSandbox(
      sessionId,
      session.userId,
      session.project,
      runtime,
      target,
    );
    let containerId: string | undefined;
    try {
      containerId = await this.createContainer(
        target.docker,
        runtime,
        volumePath,
        !target.remote,
        session.userId,
      );
      const handle: SandboxHandle = {
        containerId,
        volumePath,
        runtime,
        docker: target.docker,
        host: target.host,
        targetId: target.id,
        targetName: target.name,
        runtimeKind: target.kind,
      };
      if (target.remote) await this.syncWorkspace(handle);
      await this.prisma.sandboxInstance.update({
        where: { id: reservation.id },
        data: { containerId, status: "running", lastActiveAt: new Date() },
      });
      this.logger.log(
        `已为 session=${sessionId} 启动沙箱 container=${containerId.slice(0, 12)}`,
      );
      return handle;
    } catch (error) {
      if (containerId) await this.removeContainer(target.docker, containerId);
      await this.prisma.sandboxInstance
        .delete({ where: { id: reservation.id } })
        .catch(() => undefined);
      throw error;
    }
  }

  /** 在会话的容器内执行命令 */
  async exec(sessionId: string, cmd: string[], signal?: AbortSignal): Promise<ExecResult> {
    signal?.throwIfAborted();
    const handle = await this.ensureSandbox(sessionId);
    if (handle.runtimeKind !== "local-docker") {
      await this.syncWorkspace(handle);
    }
    const container = handle.docker.getContainer(handle.containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: this.containerWorkdir,
    });
    const stream = await exec.start({});
    signal?.throwIfAborted();
    let rejectAbort: (reason?: unknown) => void = () => undefined;
    const abort = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      void container.kill().catch(() => undefined);
      rejectAbort(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const output = await Promise.race([this.drain(stream, handle.docker), abort]);
      const info = await exec.inspect();
      return { exitCode: info.ExitCode ?? -1, output };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 在指定发布快照上运行一次隔离构建，不复用或改动任何用户沙箱。 */
  async execInWorkspace(
    runtime: ProjectRuntime,
    volumePath: string,
    cmd: string[],
  ): Promise<ExecResult> {
    const containerId = await this.createContainer(
      this.docker,
      runtime,
      volumePath,
      true,
    );
    try {
      const container = this.docker.getContainer(containerId);
      const process = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: this.containerWorkdir,
      });
      const stream = await process.start({});
      const output = await this.drain(stream, this.docker);
      const info = await process.inspect();
      return { exitCode: info.ExitCode ?? -1, output };
    } finally {
      await this.removeContainer(this.docker, containerId);
    }
  }

  /**
   * 启动一个长驻命令并返回其输出流（不 drain，用于 dev server）。
   * 进程随容器存活，客户端断开不会杀掉它。
   */
  async execStream(
    handle: SandboxHandle,
    cmd: string[],
    env?: string[],
  ): Promise<NodeJS.ReadableStream> {
    if (handle.runtimeKind !== "local-docker") {
      await this.syncWorkspace(handle);
    }
    const container = handle.docker.getContainer(handle.containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: this.containerWorkdir,
      Env: env,
    });
    return exec.start({});
  }

  /** 启动与构建沙箱配套的 Android 模拟器，并发布浏览器网关与 ADB 端口。 */
  async createEmulator(handle: SandboxHandle): Promise<EmulatorHandle> {
    const spec = handle.runtime.preview;
    const emulatorImage = this.config.get(
      "ANDROID_EMULATOR_IMAGE",
      spec.emulatorImage,
    );
    if (spec.kind !== "emulator" || !emulatorImage) {
      throw new BadRequestException("当前运行时未配置模拟器镜像");
    }
    const envoyPort = spec.envoyPort ?? 8080;
    const adbPort = spec.adbPort ?? 5555;
    const ports = [`${envoyPort}/tcp`, `${adbPort}/tcp`];
    let container: Docker.Container | undefined;
    try {
      container = await handle.docker.createContainer({
        Image: emulatorImage,
        Env: [
          `DEVICE_PROFILE=${spec.deviceProfile ?? "pixel_5"}`,
          `WEBRTC_PORT=${spec.grpcPort ?? 8554}`,
        ],
        ExposedPorts: Object.fromEntries(ports.map((port) => [port, {}])),
        HostConfig: {
          Memory: Math.max(this.memoryBytes, 2 * 1024 * 1024 * 1024),
          NanoCpus: Math.max(this.nanoCpus, 2e9),
          PortBindings: Object.fromEntries(
            ports.map((port) => [port, [{ HostPort: "" }]]),
          ),
          AutoRemove: false,
        },
        Labels: {
          "codegen.managed": "true",
          "codegen.purpose": "emulator",
        },
      });
      await container.start();
      const info = await container.inspect();
      const published = (port: number) =>
        Number(info.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0]?.HostPort);
      const publicEnvoyPort = published(envoyPort);
      const publicAdbPort = published(adbPort);
      if (!publicEnvoyPort || !publicAdbPort) {
        throw new Error("模拟器端口发布失败");
      }
      const containerIp = info.NetworkSettings?.IPAddress;
      return {
        containerId: container.id,
        adbHost: containerIp || handle.host,
        adbPort: containerIp ? adbPort : publicAdbPort,
        endpoint: `http://${handle.host}:${publicEnvoyPort}`,
      };
    } catch (error) {
      if (container) await this.removeContainer(handle.docker, container.id);
      throw new BadRequestException(
        `无法启动云手机镜像 ${emulatorImage}: ${(error as Error).message}`,
      );
    }
  }

  async removeManagedContainer(
    docker: Docker,
    containerId?: string | null,
  ): Promise<void> {
    if (containerId) await this.removeContainer(docker, containerId);
  }

  /** 把多路复用的容器输出流按文本回调（stdout+stderr 合并） */
  demuxToText(
    stream: NodeJS.ReadableStream,
    onChunk: (s: string) => void,
    docker: Docker = this.docker,
  ) {
    const sink = { write: (c: Buffer) => onChunk(c.toString("utf8")) } as never;
    docker.modem.demuxStream(stream, sink, sink);
  }

  /**
   * 重启会话容器：可靠地干掉容器内所有进程（dev server / mvn / uvicorn 等），
   * 同时保留容器文件系统（.m2 / pip 缓存）与挂载卷（node_modules）。用于"停止预览"。
   */
  async restartSandbox(sessionId: string): Promise<void> {
    const sandbox = await this.prisma.sandboxInstance.findUnique({
      where: { sessionId },
    });
    if (!sandbox) return;
    try {
      const target = await this.runtimeTarget(sandbox.targetId);
      await target.docker.getContainer(sandbox.containerId).restart({ t: 2 });
    } catch (err) {
      this.logger.warn(`重启容器失败 session=${sessionId}: ${err}`);
    }
  }

  /** 停止并移除会话容器 */
  async stopSandbox(sessionId: string): Promise<void> {
    const sandbox = await this.prisma.sandboxInstance.findUnique({
      where: { sessionId },
    });
    if (!sandbox) return;
    const target = await this.runtimeTarget(sandbox.targetId);
    await this.removeContainer(target.docker, sandbox.containerId);
    await this.prisma.sandboxInstance.delete({ where: { id: sandbox.id } });
    this.logger.log(`已回收 session=${sessionId} 的沙箱`);
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.prisma.sandboxInstance
      .update({
        where: { sessionId },
        data: { lastActiveAt: new Date() },
      })
      .catch(() => undefined);
  }

  async isSandboxRunning(sessionId: string): Promise<boolean> {
    const sandbox = await this.prisma.sandboxInstance.findUnique({
      where: { sessionId },
    });
    if (!sandbox || sandbox.containerId.startsWith("pending:")) return false;
    try {
      const target = await this.runtimeTarget(sandbox.targetId);
      return this.isContainerRunning(target.docker, sandbox.containerId);
    } catch {
      return false;
    }
  }

  // ---- 内部方法 ----

  /** 项目未显式绑定预览资源时，回退到平台 API 节点 Docker。 */
  private async selectPreviewTarget(
    userId: string,
    project: { id: string; teamId: string | null },
  ): Promise<RuntimeTarget> {
    const binding = await this.prisma.projectRuntimeBinding.findFirst({
      where: {
        projectId: project.id,
        purpose: "preview",
        environment: "preview",
        enabled: true,
      },
      include: { target: true },
    });
    if (!binding) return this.runtimeTarget(null);
    const target = binding.target;
    if (!target.enabled) {
      throw new BadRequestException(`预览资源「${target.name}」已停用`);
    }
    if (!target.purposes.includes("preview")) {
      throw new BadRequestException(`运行资源「${target.name}」未启用预览用途`);
    }
    if (target.scope === "personal" && target.userId !== userId) {
      throw new BadRequestException("当前用户不可使用该个人运行资源");
    }
    if (target.scope === "team" && target.teamId !== project.teamId) {
      throw new BadRequestException("项目与运行资源不属于同一个项目组");
    }
    return this.runtimeTarget(target.id);
  }

  private async runtimeTarget(targetId: string | null): Promise<RuntimeTarget> {
    if (!targetId) {
      return {
        id: null,
        name: "平台本机 Docker",
        kind: "local-docker",
        docker: this.docker,
        host: this.config.get("PREVIEW_PUBLIC_HOST", "localhost"),
        remote: false,
        maxPreviewInstances: null,
        capacityCpu: null,
        capacityMemoryMb: null,
      };
    }
    const target = await this.prisma.deployTarget.findUnique({
      where: { id: targetId },
    });
    if (!target) throw new BadRequestException("绑定的运行资源不存在");
    const cfg = JSON.parse(
      this.crypto.decrypt(target.encryptedConfig),
    ) as Record<string, any>;
    if (target.kind === "local-docker") {
      return {
        id: target.id,
        name: target.name,
        kind: target.kind,
        docker: this.docker,
        host:
          cfg.publicHost || this.config.get("PREVIEW_PUBLIC_HOST", "localhost"),
        remote: false,
        maxPreviewInstances: target.maxPreviewInstances,
        capacityCpu: target.capacityCpu,
        capacityMemoryMb: target.capacityMemoryMb,
      };
    }
    if (target.kind === "docker-tcp") {
      return {
        id: target.id,
        name: target.name,
        kind: target.kind,
        docker: new Docker({
          host: cfg.host,
          port: Number(cfg.port) || 2375,
          protocol: cfg.tls ? "https" : "http",
        }),
        host: cfg.publicHost || cfg.host,
        remote: true,
        maxPreviewInstances: target.maxPreviewInstances,
        capacityCpu: target.capacityCpu,
        capacityMemoryMb: target.capacityMemoryMb,
      };
    }
    if (target.kind === "docker-ssh") {
      return {
        id: target.id,
        name: target.name,
        kind: target.kind,
        docker: new Docker({
          protocol: "ssh",
          host: cfg.host,
          port: Number(cfg.port) || 22,
          username: cfg.username,
          sshOptions: {
            privateKey: cfg.privateKey,
            ...(cfg.passphrase ? { passphrase: cfg.passphrase } : {}),
          },
        } as Docker.DockerOptions),
        host: cfg.publicHost || cfg.host,
        remote: true,
        maxPreviewInstances: target.maxPreviewInstances,
        capacityCpu: target.capacityCpu,
        capacityMemoryMb: target.capacityMemoryMb,
      };
    }
    throw new BadRequestException(
      `运行资源「${target.name}」不支持开发预览，请选择本机或远程 Docker`,
    );
  }

  private async reserveSandbox(
    sessionId: string,
    userId: string,
    project: { id: string; teamId: string | null },
    runtime: ProjectRuntime,
    target: RuntimeTarget,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 事务只覆盖配额检查和占位；外部 Docker 调用不会长期占用事务。
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM (SELECT pg_advisory_xact_lock(783291)) AS capacity_lock
      `;
      await this.assertCapacity(tx, userId, project, target);
      return tx.sandboxInstance.create({
        data: {
          sessionId,
          containerId: `pending:${sessionId}`,
          image: runtime.dockerImage,
          targetId: target.id,
          targetName: target.name,
          runtimeKind: target.kind,
          memoryMb: Math.round(this.memoryBytes / 1024 / 1024),
          cpu: this.nanoCpus / 1e9,
          status: "starting",
        },
      });
    });
  }

  private async assertCapacity(
    db: Prisma.TransactionClient,
    userId: string,
    project: { id: string; teamId: string | null },
    target: RuntimeTarget,
  ) {
    const [userCount, projectCount, teamCount, targetUsage] = await Promise.all(
      [
        db.sandboxInstance.count({
          where: {
            status: { in: ["starting", "running"] },
            session: { userId },
          },
        }),
        db.sandboxInstance.count({
          where: {
            status: { in: ["starting", "running"] },
            session: { projectId: project.id },
          },
        }),
        project.teamId
          ? db.sandboxInstance.count({
              where: {
                status: { in: ["starting", "running"] },
                session: { project: { teamId: project.teamId } },
              },
            })
          : Promise.resolve(0),
        target.id
          ? db.sandboxInstance.aggregate({
              where: {
                status: { in: ["starting", "running"] },
                targetId: target.id,
              },
              _count: { _all: true },
              _sum: { cpu: true, memoryMb: true },
            })
          : Promise.resolve(null),
      ],
    );
    if (this.maxPerUser > 0 && userCount >= this.maxPerUser) {
      throw new BadRequestException(
        `个人预览实例已达到上限 ${this.maxPerUser}，请先停止不使用的预览`,
      );
    }
    if (this.maxPerProject > 0 && projectCount >= this.maxPerProject) {
      throw new BadRequestException(
        `项目预览实例已达到上限 ${this.maxPerProject}`,
      );
    }
    if (this.maxPerTeam > 0 && project.teamId && teamCount >= this.maxPerTeam) {
      throw new BadRequestException(
        `项目组预览实例已达到上限 ${this.maxPerTeam}`,
      );
    }
    if (targetUsage) {
      const active = targetUsage._count._all;
      if (target.maxPreviewInstances && active >= target.maxPreviewInstances) {
        throw new BadRequestException(
          `运行资源「${target.name}」实例已满（${active}/${target.maxPreviewInstances}）`,
        );
      }
      const nextCpu = (targetUsage._sum.cpu || 0) + this.nanoCpus / 1e9;
      if (target.capacityCpu && nextCpu > target.capacityCpu) {
        throw new BadRequestException(`运行资源「${target.name}」CPU 配额不足`);
      }
      const nextMemory =
        (targetUsage._sum.memoryMb || 0) + this.memoryBytes / 1024 / 1024;
      if (target.capacityMemoryMb && nextMemory > target.capacityMemoryMb) {
        throw new BadRequestException(`运行资源「${target.name}」内存配额不足`);
      }
    }
  }

  private async syncWorkspace(handle: SandboxHandle): Promise<void> {
    const pack = tarFs.pack(handle.volumePath, {
      ignore: (name) => SYNC_IGNORE.test(name),
    });
    await handle.docker
      .getContainer(handle.containerId)
      .putArchive(pack as never, {
        path: this.containerWorkdir,
      });
  }

  private async createContainer(
    docker: Docker,
    runtime: ProjectRuntime,
    volumePath: string,
    bindWorkspace: boolean,
    userId?: string,
  ): Promise<string> {
    await this.ensureImage(docker, runtime.dockerImage, userId);
    // 需要 web 预览的项目：创建时就发布预览端口（dockerode 无法给运行中的容器追加端口）。
    // HostPort 留空 → 由 Docker 分配临时端口，预览启动后再 inspect 取回。
    const previewPort = runtime.preview.port;
    const publishPreview =
      (runtime.preview.kind === "web-dev-server" ||
        runtime.preview.kind === "http-service") &&
      !!previewPort;
    const portKey = `${previewPort}/tcp`;

    const container = await docker.createContainer({
      Image: runtime.dockerImage,
      Cmd: ["sleep", "infinity"],
      WorkingDir: this.containerWorkdir,
      Env: Object.entries(runtimeDependencyEnv(
        runtime,
        this.config.get<string>('DEPENDENCY_NPM_REGISTRY'),
        this.config.get<string>('DEPENDENCY_PIP_INDEX_URL'),
        this.config.get<string>('DEPENDENCY_MAVEN_MIRROR_URL'),
        this.config.get<string>('DEPENDENCY_ACCESS_POLICY'),
        this.config.get<string>('K8S_GENERATION_REQUIRE_DEPENDENCY_PROXY'),
      )).map(([k, v]) => `${k}=${v}`),
      Tty: false,
      ExposedPorts: publishPreview ? { [portKey]: {} } : undefined,
      HostConfig: {
        Binds: bindWorkspace
          ? [`${volumePath}:${this.containerWorkdir}`]
          : undefined,
        Memory: this.memoryBytes,
        NanoCpus: this.nanoCpus,
        PidsLimit: this.pidsLimit,
        Tmpfs: {
          "/tmp": `rw,nosuid,nodev,noexec,size=${this.tmpfsBytes}`,
        },
        PortBindings: publishPreview
          ? { [portKey]: [{ HostPort: "" }] }
          : undefined,
        // 网络隔离由部署环境的网络策略进一步收紧（见安全要点）
        AutoRemove: false,
      },
      Labels: {
        "codegen.managed": "true",
        "codegen.purpose": "preview",
      },
    });
    await container.start();
    return container.id;
  }

  /** 镜像不存在时按需拉取；私有仓库凭证复用当前用户的 Registry 配置。 */
  private async ensureImage(docker: Docker, image: string, userId?: string) {
    try {
      await docker.getImage(image).inspect();
      return;
    } catch {
      // 目标节点尚未缓存镜像，继续拉取。
    }
    let authconfig: Docker.AuthConfig | undefined;
    const first = image.split('/')[0];
    const registryHost =
      first.includes('.') || first.includes(':') || first === 'localhost'
        ? first
        : undefined;
    if (userId && registryHost) {
      const registries = await this.prisma.registry.findMany({
        where: { userId },
        select: { encryptedConfig: true },
      });
      for (const registry of registries) {
        try {
          const cfg = JSON.parse(
            this.crypto.decrypt(registry.encryptedConfig),
          ) as { url: string; username: string; password: string };
          const configuredHost = cfg.url
            .replace(/^https?:\/\//, '')
            .split('/')[0];
          if (configuredHost === registryHost) {
            authconfig = {
              serveraddress: registryHost,
              username: cfg.username,
              password: cfg.password,
            };
            break;
          }
        } catch {
          // 跳过无法解密的历史配置。
        }
      }
    }
    this.logger.log(`目标节点未缓存镜像，开始拉取 ${image}`);
    try {
      const stream = await docker.pull(image, { authconfig });
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    } catch (error) {
      throw new BadRequestException(
        `拉取镜像 ${image} 失败: ${(error as Error).message}`,
      );
    }
  }

  /** 取回容器某个内部端口映射到的宿主机端口（预览用） */
  async getPublishedPort(
    handle: SandboxHandle,
    containerPort: number,
  ): Promise<number | null> {
    try {
      const info = await handle.docker
        .getContainer(handle.containerId)
        .inspect();
      const binding = info.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
      const hostPort = binding?.[0]?.HostPort;
      return hostPort ? Number(hostPort) : null;
    } catch {
      return null;
    }
  }

  private async isContainerRunning(
    docker: Docker,
    containerId: string,
  ): Promise<boolean> {
    try {
      const info = await docker.getContainer(containerId).inspect();
      return info.State?.Running === true;
    } catch {
      return false;
    }
  }

  private async removeContainer(
    docker: Docker,
    containerId: string,
  ): Promise<void> {
    try {
      const container = docker.getContainer(containerId);
      await container.remove({ force: true });
    } catch (err) {
      this.logger.warn(`移除容器 ${containerId.slice(0, 12)} 失败: ${err}`);
    }
  }

  private async reapIdleSandboxes() {
    if (this.idleTimeoutMs <= 0) return;
    const cutoff = new Date(Date.now() - this.idleTimeoutMs);
    const idle = await this.prisma.sandboxInstance.findMany({
      where: { lastActiveAt: { lt: cutoff }, status: { in: ["starting", "running"] } },
      select: {
        id: true,
        sessionId: true,
        containerId: true,
        targetId: true,
      },
      take: 20,
    });
    for (const sandbox of idle) {
      const claimed = await this.prisma.sandboxInstance.updateMany({
        where: { id: sandbox.id, status: { in: ["starting", "running"] } },
        data: { status: "stopping" },
      });
      if (!claimed.count) continue;
      const target = await this.runtimeTarget(sandbox.targetId).catch(() => ({
        docker: this.docker,
      }));
      const preview = await this.prisma.previewInstance.findUnique({
        where: { sessionId: sandbox.sessionId },
        select: { emulatorContainerId: true },
      });
      await this.removeManagedContainer(
        target.docker,
        preview?.emulatorContainerId,
      );
      await this.removeContainer(target.docker, sandbox.containerId);
      await this.prisma.sandboxInstance
        .delete({ where: { id: sandbox.id } })
        .catch(() => undefined);
      await this.prisma.previewInstance
        .update({
          where: { sessionId: sandbox.sessionId },
          data: {
            status: "stopped",
            url: null,
            webrtcEndpoint: null,
            emulatorContainerId: null,
            lastActiveAt: new Date(),
          },
        })
        .catch(() => undefined);
      this.logger.log(`已回收空闲用户工作区沙箱 session=${sandbox.sessionId}`);
    }
  }

  private async touch(sandboxId: string): Promise<void> {
    await this.prisma.sandboxInstance.update({
      where: { id: sandboxId },
      data: { lastActiveAt: new Date() },
    });
  }

  /** 读取 docker exec 的多路复用流为纯文本 */
  private drain(
    stream: NodeJS.ReadableStream,
    docker: Docker,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = Buffer.alloc(0);
      let truncated = false;
      const append = (chunk: Buffer) => {
        output = Buffer.concat([output, chunk]);
        if (output.length > this.maxExecOutputBytes) {
          truncated = true;
          output = output.subarray(output.length - this.maxExecOutputBytes);
        }
      };
      docker.modem.demuxStream(
        stream,
        { write: append } as never,
        { write: append } as never,
      );
      stream.on("end", () =>
        resolve(
          `${truncated ? "[较早输出因超过平台限制已截断]\n" : ""}${output.toString("utf8")}`,
        ),
      );
      stream.on("error", reject);
    });
  }
}

/** 解析 Docker socket 路径：优先 DOCKER_HOST，其次 Docker Desktop 用户 socket，最后系统默认 */
function resolveDockerSocket(): string {
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith("unix://")) {
    return host.replace("unix://", "");
  }
  const desktopSocket = join(homedir(), ".docker", "run", "docker.sock");
  if (existsSync(desktopSocket)) {
    return desktopSocket;
  }
  return "/var/run/docker.sock";
}
