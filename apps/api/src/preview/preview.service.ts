import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { readdir, readFile, stat } from "fs/promises";
import { join, relative, resolve } from "path";
import Docker from "dockerode";
import { PrismaService } from "../prisma/prisma.service";
import { SandboxService } from "../sandbox/sandbox.service";
import { getRuntime } from "../sandbox/language-runtime";
import { ProjectAccessService } from "../project-access/project-access.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { K8sPreviewService } from "./k8s-preview.service";
import { ConfigService } from "@nestjs/config";
import { PreviewBuildQueryDto } from "./dto/preview-build-query.dto";

interface LivePreview {
  stream: NodeJS.ReadableStream;
  docker: Docker;
  logs: string;
  ready: boolean;
  emulatorContainerId?: string;
}

export interface ApiEndpoint {
  method: string;
  path: string;
}

export interface ProxyRequestInput {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

const LOG_TAIL_LIMIT = 8000;

@Injectable()
export class PreviewService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PreviewService.name);
  // 内存态：sessionId → 运行中的 dev server 流与日志
  private readonly live = new Map<string, LivePreview>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sandbox: SandboxService,
    private readonly access: ProjectAccessService,
    private readonly workspaces: WorkspaceService,
    private readonly k8sPreview: K8sPreviewService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    const interrupted = await this.prisma.previewInstance.findMany({ where: { status: "starting" }, select: { id: true, extra: true } });
    const dockerIds = interrupted
      .filter((row) => (row.extra as Record<string, unknown> | null)?.runtimeKind !== "k8s")
      .map((row) => row.id);
    const recovered = dockerIds.length ? await this.prisma.previewInstance.updateMany({
      where: { id: { in: dockerIds } },
      data: { status: "failed", logsTail: "平台服务重启，预览启动状态已中断，请重新启动预览。" },
    }) : { count: 0 };
    if (recovered.count) {
      this.logger.warn(`已校准 ${recovered.count} 个中断的预览启动状态`);
    }
  }

  /** 启动前端 dev server（异步就绪）：npm install → npm run dev，检测就绪后置 ready */
  async start(userId: string, sessionId: string, requirementId?: string) {
    await this.access.requireSession(userId, sessionId, "edit");
    const existing = await this.prisma.previewInstance.findUnique({ where: { sessionId } });
    if (existing && (existing.extra as Record<string, unknown> | null)?.runtimeKind === "k8s") {
      await this.k8sPreview.stop(userId, existing, userId);
    }
    const k8sResult = await this.k8sPreview.startIfBound(userId, sessionId, requirementId);
    if (k8sResult) return k8sResult;
    if (this.config.get<string>("LOCAL_PREVIEW_ENABLED", "false") !== "true") {
      throw new BadRequestException({
        code: "K8S_PREVIEW_BINDING_REQUIRED",
        message: "项目未绑定可用的 Kubernetes 预览环境，本地容器预览已禁用",
      });
    }
    // 已在跑 → 先停，并等端口释放（后端进程如 java 退出后端口不会立即释放，避免"端口占用"）
    if (this.live.has(sessionId)) {
      await this.stop(userId, sessionId);
      await new Promise((r) => setTimeout(r, 3000));
    }

    const handle = await this.sandbox.ensureSandbox(sessionId);
    const preview = handle.runtime.preview;
    if (preview.kind === "emulator") {
      return this.startEmulator(sessionId, handle);
    }
    const previewable =
      preview.kind === "web-dev-server" || preview.kind === "http-service";
    if (!previewable || !preview.port || !preview.startCommand) {
      throw new BadRequestException(
        `${handle.runtime.displayName} 不支持在线预览`,
      );
    }

    const hostPort = await this.sandbox.getPublishedPort(handle, preview.port);
    if (!hostPort) {
      throw new BadRequestException(
        "预览端口未发布（容器可能创建于前端支持之前，请重建会话）",
      );
    }
    const url = `http://${handle.host}:${hostPort}`;

    await this.prisma.previewInstance.upsert({
      where: { sessionId },
      create: {
        sessionId,
        kind: preview.kind,
        status: "starting",
        url,
        hostPort,
        containerPort: preview.port,
        targetId: handle.targetId,
        targetName: handle.targetName,
      },
      update: {
        status: "starting",
        url,
        hostPort,
        containerPort: preview.port,
        targetId: handle.targetId,
        targetName: handle.targetName,
        logsTail: null,
        lastActiveAt: new Date(),
      },
    });

    // 前端需要先 npm install；后端(如 Spring Boot)由 startCommand 自行拉依赖，无需 install
    const install = handle.runtime.installCommand;
    const shellCmd = install
      ? `${install} && ${preview.startCommand}`
      : preview.startCommand!;
    const cmd = ["sh", "-c", shellCmd];
    const stream = await this.sandbox.execStream(handle, cmd);
    const state: LivePreview = {
      stream,
      docker: handle.docker,
      logs: "",
      ready: false,
    };
    this.live.set(sessionId, state);
    this.watchReady(sessionId, state, preview.readyRegex);

    this.logger.log(`预览启动中 session=${sessionId} url=${url}`);
    return { status: "starting", url };
  }

  /** 停止预览并释放本用户的沙箱资源；下次按需重建。 */
  async stop(userId: string, sessionId: string) {
    await this.access.requireSession(userId, sessionId, "edit");
    const record = await this.prisma.previewInstance.findUnique({
      where: { sessionId },
    });
    if (record && await this.k8sPreview.stop(userId, record, userId)) {
      return { status: "stopped" };
    }
    if (record?.emulatorContainerId) {
      const handle = await this.sandbox.ensureSandbox(sessionId);
      await this.sandbox.removeManagedContainer(
        handle.docker,
        record.emulatorContainerId,
      );
    }
    const state0 = this.live.get(sessionId);
    (
      state0?.stream as NodeJS.ReadableStream & { destroy?: () => void }
    )?.destroy?.();
    await this.sandbox.stopSandbox(sessionId);
    const state = this.live.get(sessionId);
    (
      state?.stream as NodeJS.ReadableStream & { destroy?: () => void }
    )?.destroy?.();
    this.live.delete(sessionId);
    await this.prisma.previewInstance
      .update({
        where: { sessionId },
        data: {
          status: "stopped",
          url: null,
          webrtcEndpoint: null,
          emulatorContainerId: null,
          lastActiveAt: new Date(),
        },
      })
      .catch(() => undefined);
    return { status: "stopped" };
  }

  /** 查询预览状态 + 最近日志 */
  async status(userId: string, sessionId: string) {
    const session = await this.requireSession(userId, sessionId);
    await this.sandbox.touchSession(sessionId);
    let record = await this.prisma.previewInstance.findUnique({
      where: { sessionId },
    });
    if (!record) {
      let kind: string | undefined;
      try {
        kind = getRuntime(session.project.language).preview.kind;
      } catch {
        // 未知的历史运行时仍按普通空预览处理。
      }
      return { status: "none", kind, teamId: session.project.teamId };
    }
    const k8sRecord = await this.k8sPreview.status(userId, record);
    if (k8sRecord) {
      const { webrtcTokenEnc: _secret, ...safeRecord } = k8sRecord;
      return { ...safeRecord, teamId: session.project.teamId };
    }
    if (
      (record.status === "ready" || record.status === "starting") &&
      !(await this.sandbox.isSandboxRunning(sessionId))
    ) {
      record = await this.prisma.previewInstance.update({
        where: { sessionId },
        data: {
          status: "stopped",
          url: null,
          webrtcEndpoint: null,
          emulatorContainerId: null,
          logsTail: "运行容器已不存在，预览状态已自动校准。",
          lastActiveAt: new Date(),
        },
      });
    }
    const liveLogs = this.live.get(sessionId)?.logs;
    // 加密凭证也不应进入浏览器响应；前端只需要已授权的投屏端点。
    const { webrtcTokenEnc: _secret, ...safeRecord } = record;
    return { ...safeRecord, teamId: session.project.teamId, logsTail: liveLogs ?? record.logsTail };
  }

  /** MCP/自动化只读快照：不 touch 会话、不探测运行时、不校准数据库状态。 */
  async readStatus(userId: string, sessionId: string) {
    const session = await this.access.requireSession(userId, sessionId, 'read');
    const record = await this.prisma.previewInstance.findUnique({ where: { sessionId } });
    if (!record) return {
      sessionId,
      projectId: session.projectId,
      status: 'none',
      observedFrom: 'database',
    };
    return {
      id: record.id,
      sessionId,
      projectId: session.projectId,
      kind: record.kind,
      status: record.status,
      url: record.url,
      targetId: record.targetId,
      targetName: record.targetName,
      requirementId: record.requirementId,
      serviceKey: record.serviceKey,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      observedFrom: 'database',
    };
  }

  async builds(userId: string, sessionId: string, query: PreviewBuildQueryDto) {
    await this.access.requireSession(userId, sessionId, "read");
    return this.k8sPreview.listBuilds(sessionId, query);
  }

  async cancelBuild(userId: string, sessionId: string, buildId: string) {
    await this.access.requireSession(userId, sessionId, "edit");
    return this.k8sPreview.cancelBuild(userId, sessionId, buildId);
  }

  async buildMetrics(userId: string, sessionId: string, days?: number) {
    const session = await this.access.requireSession(userId, sessionId, "read");
    return this.k8sPreview.buildMetrics(session.projectId, days);
  }

  /**
   * 代理转发一次请求到运行中的预览服务（避免浏览器跨域直连预览端口）。
   * 用于后端 API 的「在线调试」。
   */
  async proxyRequest(
    userId: string,
    sessionId: string,
    input: ProxyRequestInput,
  ): Promise<{
    status: number;
    contentType: string;
    headers: Record<string, string>;
    body: string;
    ms: number;
    size: number;
  }> {
    await this.requireSession(userId, sessionId);
    await this.sandbox.touchSession(sessionId);
    const record = await this.prisma.previewInstance.findUnique({
      where: { sessionId },
    });
    if ((!record?.hostPort && !record?.url) || record.status !== "ready") {
      throw new ConflictException({ code: 'PREVIEW_NOT_READY', message: '预览未就绪，请先启动预览' });
    }
    const method = (input.method || "GET").toUpperCase();
    const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
    const baseUrl = new URL(
      record.url || `http://127.0.0.1:${record.hostPort}`,
    );
    const url = `${baseUrl.protocol}//${baseUrl.host}${path}`;
    const hasBody = !["GET", "HEAD"].includes(method) && !!input.body;

    // 组装请求头：用户自定义优先；有 body 且未指定 content-type 时默认 JSON
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers ?? {})) {
      if (k.trim()) headers[k.trim()] = v;
    }
    if (
      hasBody &&
      !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
    ) {
      headers["Content-Type"] = "application/json";
    }

    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: hasBody ? input.body : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (respHeaders[k] = v));
      return {
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        headers: respHeaders,
        body: text.slice(0, 200_000),
        ms: Date.now() - t0,
        size: Buffer.byteLength(text, "utf8"),
      };
    } catch (err) {
      this.logger.warn(`预览代理请求失败 session=${sessionId}: ${(err as Error).message}`);
      throw new BadRequestException({ code: 'PREVIEW_UPSTREAM_FAILED', message: '预览服务请求失败或超时' });
    }
  }

  /** 从生成的代码里提取 API 端点（best-effort，按 runtime 类别解析） */
  async endpoints(userId: string, sessionId: string): Promise<ApiEndpoint[]> {
    const session = await this.access.requireSession(userId, sessionId, "read");
    let runtime;
    try {
      runtime = getRuntime(session.project.language);
    } catch {
      return [];
    }
    if (runtime.category !== "backend") return [];
    const workspace = await this.workspaces.ensureForSession(userId, sessionId);
    const files = await readSourceFiles(resolve(workspace.path));
    return dedupeEndpoints(extractEndpoints(runtime.id, files));
  }

  // ---- 内部 ----

  private async startEmulator(
    sessionId: string,
    handle: Awaited<ReturnType<SandboxService["ensureSandbox"]>>,
  ) {
    const preview = handle.runtime.preview;
    if (!preview.startCommand) {
      throw new BadRequestException("移动端运行时未配置构建安装命令");
    }
    const previous = await this.prisma.previewInstance.findUnique({
      where: { sessionId },
      select: { emulatorContainerId: true },
    });
    await this.sandbox.removeManagedContainer(
      handle.docker,
      previous?.emulatorContainerId,
    );
    const emulator = await this.sandbox.createEmulator(handle);
    try {
      await this.prisma.previewInstance.upsert({
        where: { sessionId },
        create: {
          sessionId,
          kind: "emulator",
          status: "starting",
          url: emulator.endpoint,
          webrtcEndpoint: emulator.endpoint,
          emulatorContainerId: emulator.containerId,
          targetId: handle.targetId,
          targetName: handle.targetName,
          extra: { deviceProfile: preview.deviceProfile ?? "pixel_5" },
        },
        update: {
          kind: "emulator",
          status: "starting",
          url: emulator.endpoint,
          webrtcEndpoint: emulator.endpoint,
          emulatorContainerId: emulator.containerId,
          targetId: handle.targetId,
          targetName: handle.targetName,
          logsTail: null,
          extra: { deviceProfile: preview.deviceProfile ?? "pixel_5" },
          lastActiveAt: new Date(),
        },
      });
      const install = handle.runtime.installCommand ?? "true";
      const stream = await this.sandbox.execStream(
        handle,
        ["sh", "-c", `${install} && ${preview.startCommand}`],
        [
          `EMULATOR_ADB_HOST=${emulator.adbHost}`,
          `EMULATOR_ADB_PORT=${emulator.adbPort}`,
          `EMULATOR_LAUNCH_COMMAND=${preview.launchCommand ?? ""}`,
        ],
      );
      const state: LivePreview = {
        stream,
        docker: handle.docker,
        logs: "",
        ready: false,
        emulatorContainerId: emulator.containerId,
      };
      this.live.set(sessionId, state);
      this.watchReady(sessionId, state, preview.readyRegex);
      return { status: "starting", url: emulator.endpoint, kind: "emulator" };
    } catch (error) {
      await this.sandbox.removeManagedContainer(
        handle.docker,
        emulator.containerId,
      );
      throw error;
    }
  }

  private watchReady(
    sessionId: string,
    state: LivePreview,
    readyRegex?: RegExp,
  ) {
    const onText = (chunk: string) => {
      state.logs = (state.logs + chunk).slice(-LOG_TAIL_LIMIT);
      if (!state.ready && readyRegex && readyRegex.test(state.logs)) {
        state.ready = true;
        this.markReady(sessionId, state.logs);
      }
    };
    this.sandbox.demuxToText(state.stream, onText, state.docker);

    state.stream.on("end", () => {
      if (!state.ready) this.markFailed(sessionId, state.logs);
    });
    state.stream.on("error", () => {
      if (!state.ready) this.markFailed(sessionId, state.logs);
    });
  }

  private markReady(sessionId: string, logs: string) {
    this.logger.log(`预览就绪 session=${sessionId}`);
    this.prisma.previewInstance
      .update({
        where: { sessionId },
        data: { status: "ready", logsTail: logs, lastActiveAt: new Date() },
      })
      .catch(() => undefined);
  }

  private markFailed(sessionId: string, logs: string) {
    this.logger.warn(`预览失败 session=${sessionId}`);
    const state = this.live.get(sessionId);
    if (state?.emulatorContainerId) {
      this.sandbox
        .removeManagedContainer(state.docker, state.emulatorContainerId)
        .catch(() => undefined);
    }
    this.prisma.previewInstance
      .update({
        where: { sessionId },
        data: {
          status: "failed",
          logsTail: logs,
          emulatorContainerId: null,
          webrtcEndpoint: null,
          url: null,
        },
      })
      .catch(() => undefined);
  }

  private async requireSession(userId: string, sessionId: string) {
    return this.access.requireSession(userId, sessionId, "read");
  }
}

// ---- 端点解析（模块级纯函数，便于扩展更多语言）----

const SRC_IGNORE = new Set(["node_modules", ".git", "target", "dist", "build"]);

async function readSourceFiles(
  root: string,
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  const walk = async (dir: string) => {
    if (out.length >= 200) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 200) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SRC_IGNORE.has(e.name) || e.name.startsWith(".")) continue;
        await walk(full);
      } else if (e.isFile() && /\.(java|js|ts|py)$/.test(e.name)) {
        try {
          const info = await stat(full);
          if (info.size > 200 * 1024) continue;
          out.push({
            path: relative(root, full),
            content: await readFile(full, "utf8"),
          });
        } catch {
          /* skip */
        }
      }
    }
  };
  await walk(root);
  return out;
}

/** 按 runtime 提取端点；新增语言时在这里加一个分支 */
function extractEndpoints(
  runtimeId: string,
  files: { path: string; content: string }[],
): ApiEndpoint[] {
  if (runtimeId === "java") return extractSpringEndpoints(files);
  if (runtimeId === "node") return extractExpressEndpoints(files);
  if (runtimeId === "python") return extractFastapiEndpoints(files);
  return [];
}

// Express: app.get('/path', ...) / router.post("/path", ...)
function extractExpressEndpoints(
  files: { path: string; content: string }[],
): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  const re =
    /\b(?:app|router)\.(get|post|put|delete|patch)\(\s*[`'"]([^`'"]+)[`'"]/g;
  for (const f of files) {
    if (!/\.(js|ts)$/.test(f.path)) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content)))
      out.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return out;
}

// FastAPI: @app.get("/path") / @router.post('/path')
function extractFastapiEndpoints(
  files: { path: string; content: string }[],
): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  const re =
    /@(?:app|router)\.(get|post|put|delete|patch)\(\s*[`'"]([^`'"]+)[`'"]/g;
  for (const f of files) {
    if (!f.path.endsWith(".py")) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content)))
      out.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return out;
}

// Spring: 类级 @RequestMapping 前缀 + 方法级 @Get/Post/Put/Delete/PatchMapping
function extractSpringEndpoints(
  files: { path: string; content: string }[],
): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  for (const f of files) {
    if (!f.path.endsWith(".java")) continue;
    const base =
      f.content.match(
        /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']/,
      )?.[1] ?? "";
    const re =
      /@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["'][^)]*\))?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content))) {
      const method = m[1].toUpperCase();
      const sub = m[2] ?? "";
      const path = ("/" + `${base}/${sub}`.replace(/\/+/g, "/")).replace(
        /\/+/g,
        "/",
      );
      out.push({ method, path: path.replace(/\/$/, "") || "/" });
    }
  }
  return out;
}

function dedupeEndpoints(list: ApiEndpoint[]): ApiEndpoint[] {
  const seen = new Set<string>();
  const out: ApiEndpoint[] = [];
  for (const e of list) {
    const key = `${e.method} ${e.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
