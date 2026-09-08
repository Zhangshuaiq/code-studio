import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GenerationExecutorService } from './generation-executor.service';
import { PreviewService } from '../preview/preview.service';
import { ModelConfigService } from '../model-config/model-config.service';
import { GitService, FileChange } from '../git/git.service';
import { GitSettingsService } from '../git/git-settings.service';
import { ensureScaffold } from '../sandbox/scaffold';
import { ClaudeAgentProvider } from './providers/claude-agent.provider';
import { SimpleLlmProvider } from './providers/simple-llm.provider';
import { AiderProvider } from './providers/aider.provider';
import {
  AgentEvent,
  GenerationProvider,
  ModelCredential,
} from './providers/generation-provider';
import { ProjectAccessService } from '../project-access/project-access.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { GenerationTaskListQueryDto } from './dto/task-admin.dto';
import { pageArgs, pageResult } from '../common/dto/page-query.dto';
import { diagnosticMessage, redactDiagnosticText } from '../common/redact-diagnostic';
import {
  assertWorkspaceWithinLimits,
  WorkspaceQuotaError,
  workspaceLimits,
} from '../common/workspace-quota';

const MAX_TASK_LOG_CHARS = 1_000_000;

export interface RunResult {
  taskId: string;
  status: 'succeeded' | 'failed';
  log: string;
  events: AgentEvent[];
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly executor: GenerationExecutorService,
    private readonly preview: PreviewService,
    private readonly modelConfigs: ModelConfigService,
    private readonly git: GitService,
    private readonly gitSettings: GitSettingsService,
    private readonly access: ProjectAccessService,
    private readonly workspaces: WorkspaceService,
    private readonly claudeAgent: ClaudeAgentProvider,
    private readonly simpleLlm: SimpleLlmProvider,
    private readonly aider: AiderProvider,
  ) {}

  /**
   * 生成引擎选择：由该用户模型配置的 engine 决定。
   *  - aider  → 智能体式增量编辑（子进程跑 aider，接 BYOK OpenAI 兼容模型）
   *  - simple → 一把梭 JSON 生成（默认）
   * 无 BYOK 配置时（credential 为空）回退 .env 的 AGENT_PROVIDER，便于本地调试。
   */
  private provider(cred?: ModelCredential): GenerationProvider {
    if (cred?.engine === 'aider') return this.aider;
    if (!cred && this.config.get<string>('AGENT_PROVIDER') === 'claude-agent')
      return this.claudeAgent;
    return this.simpleLlm;
  }

  async runTask(
    userId: string,
    sessionId: string,
    prompt: string,
    onEvent?: (e: AgentEvent) => void,
    queuedTaskId?: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    signal?.throwIfAborted();
    const session = await this.access.requireSession(userId, sessionId, 'edit');

    if (!queuedTaskId) {
      const running = await this.prisma.task.count({
        where: { sessionId, status: { in: ['queued', 'running', 'cancelling'] } },
      });
      if (running) throw new ConflictException({ code: 'GENERATION_ALREADY_ACTIVE', message: '当前会话已有生成任务正在执行' });
    }

    // BYOK：解析该会话使用的模型凭证（未配置会抛出，引导去设置页）
    const credentials = await this.modelConfigs.resolveForGeneration(
      userId,
      session.modelConfigId,
    );
    signal?.throwIfAborted();

    const handle = await this.executor.prepare(sessionId);
    const task = queuedTaskId
      ? await this.prisma.task.update({
          where: { id: queuedTaskId },
          data: { status: 'running', startedAt: new Date(), finishedAt: null, failureCode: null },
        })
      : await this.prisma.task.create({
          data: { sessionId, prompt, status: 'running', startedAt: new Date() },
        });

    try {

    // 提交身份绑定当前平台用户；不依赖共享工作区中的 user.name / user.email。
    const gitIdentity = await this.gitSettings.resolveIdentity(userId);
    await this.git.ensureRepo(
      handle.volumePath,
      gitIdentity,
      session.project.remote?.branch || 'main',
    );

    const result = await this.provider(credentials).generate({
      userId,
      prompt,
      cwd: handle.volumePath,
      runtime: handle.runtime,
      resumeId: session.agentContextId ?? undefined,
      credentials,
      onEvent,
      signal,
    });

    // 与前端一致地拼接：text 增量原样连接（流式会有很多小片段，不能按行 join），
    // 结构化事件各占一行。避免历史里出现"每字一行"的碎片。
    let log = '';
    for (const e of result.events) {
      if (e.kind === 'text') log += e.text ?? '';
      else if (e.kind === 'tool_use')
        log += `\n» ${e.toolName}(${redactDiagnosticText(short(e.toolInput))})`;
      else if (e.kind === 'result') log += `\n\n${e.text ?? ''}`;
      else if (e.kind === 'system') log += `\n${e.text ?? ''}`;
    }
    log = log.trim();

    let status: RunResult['status'] = result.isError ? 'failed' : 'succeeded';

    // Provider 与脚手架之外再设一道统一门禁，越界结果不得进入构建或 Git 历史。
    await assertWorkspaceWithinLimits(
      handle.volumePath,
      workspaceLimits((key, fallback) => Number(this.config.get(key, fallback))),
    );

    // 生成成功 → 确定性兜底补齐脚手架（弱模型常漏 package.json 等），再提交
    if (status === 'succeeded') {
      signal?.throwIfAborted();
      try {
        const repaired = await ensureScaffold(handle.runtime, handle.volumePath);
        if (repaired.length) {
          const note = `已自动补齐缺失文件: ${repaired.join(', ')}`;
          this.logger.warn(`${note} (session=${sessionId})`);
          log += `\n\n⚙ ${note}`;
          onEvent?.({ kind: 'result', text: note });
        }
      } catch (err) {
        this.logger.warn(`脚手架兜底失败 session=${sessionId}: ${err}`);
      }
    }

    if (status === 'succeeded') {
      await assertWorkspaceWithinLimits(
        handle.volumePath,
        workspaceLimits((key, fallback) => Number(this.config.get(key, fallback))),
      );
    }

    // 生成结果进入 Git 前执行确定性构建门禁，避免“生成成功但项目不可运行”。
    const verify =
      this.config.get<string>('GENERATION_VERIFY', 'true') !== 'false';
    if (
      status === 'succeeded' &&
      verify &&
      handle.runtime.category !== 'mobile' &&
      handle.runtime.buildCommand
    ) {
      const command = handle.runtime.installCommand
        ? `${handle.runtime.installCommand} && ${handle.runtime.buildCommand}`
        : handle.runtime.buildCommand;
      onEvent?.({ kind: 'system', text: `正在验证生成结果: ${command}` });
      const validation = await this.executor.exec(sessionId, [
        'sh',
        '-c',
        command,
      ], signal, {
        taskId: task.id,
        onOutput: (chunk) =>
          onEvent?.({ kind: 'system', text: redactDiagnosticText(chunk) }),
      });
      log += `\n\n⚙ 构建验证 (${command})\n${redactDiagnosticText(validation.output, [], 12_000)}`;
      if (validation.exitCode !== 0) {
        status = 'failed';
        await this.prisma.task.update({
          where: { id: task.id },
          data: { failureCode: validation.failureCode ?? 'command_failed' },
        });
        const note = `构建验证失败（退出码 ${validation.exitCode}），本次结果未提交`;
        log += `\n${note}`;
        onEvent?.({ kind: 'result', text: note });
      } else {
        onEvent?.({ kind: 'result', text: '构建验证通过' });
      }
    }

    // 生成成功 → 提交为一次记录（提交信息=用户需求），本次改动/历史由 git 追踪
    if (status === 'succeeded') {
      await this.git.commitAll(handle.volumePath, prompt, gitIdentity);
    }

    if (log.length > MAX_TASK_LOG_CHARS) {
      log = `[较早日志因超过平台限制已截断]\n${log.slice(-MAX_TASK_LOG_CHARS)}`;
    }

    await this.prisma.$transaction([
      this.prisma.task.update({
        where: { id: task.id },
        data: { status, resultLog: log, finishedAt: new Date() },
      }),
      this.prisma.session.update({
        where: { id: sessionId },
        data: { agentContextId: result.contextId ?? session.agentContextId },
      }),
    ]);

    // 「实时预览」精髓：生成成功后自动拉起（前端 dev server / 后端 HTTP 服务）
    const autoPreview =
      this.config.get<string>('AUTO_PREVIEW', 'true') !== 'false';
    const previewable =
      handle.runtime.preview.kind === 'web-dev-server' ||
      handle.runtime.preview.kind === 'http-service';
    if (status === 'succeeded' && autoPreview && previewable) {
      this.preview.start(userId, sessionId).catch((err) => {
        this.logger.warn(`自动预览启动失败 session=${sessionId}: ${err}`);
      });
    }

      return { taskId: task.id, status, log, events: result.events };
    } catch (error) {
      const message = diagnosticMessage(error);
      const terminalStatus = error instanceof Error && error.name === 'TaskCancelledError'
        ? 'cancelled'
        : error instanceof Error && error.name === 'TaskTimeoutError'
          ? 'timed_out'
          : 'failed';
      await this.prisma.task
        .updateMany({
          where: { id: task.id, status: { in: ['running', 'cancelling'] } },
          data: {
            status: terminalStatus,
            ...(error instanceof WorkspaceQuotaError
              ? { failureCode: 'workspace_quota_exceeded' }
              : {}),
            resultLog: terminalStatus === 'cancelled' ? '任务已由用户取消' : terminalStatus === 'timed_out' ? `任务执行超时: ${message}` : `任务执行异常: ${message}`,
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async createQueuedTask(userId: string, sessionId: string, prompt: string) {
    const session = await this.access.requireSession(userId, sessionId, 'edit');
    const active = await this.prisma.task.count({
      where: { sessionId, status: { in: ['queued', 'running', 'cancelling'] } },
    });
    if (active) throw new ConflictException({ code: 'GENERATION_ALREADY_ACTIVE', message: '当前会话已有生成任务正在执行' });
    const dailyLimit = Number(
      this.config.get('PROJECT_DAILY_GENERATION_LIMIT', 100),
    );
    if (dailyLimit > 0) {
      const used = await this.prisma.task.count({
        where: {
          session: { projectId: session.projectId },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
        },
      });
      if (used >= dailyLimit) {
        throw new ConflictException({ code: 'GENERATION_DAILY_QUOTA_EXCEEDED', message: `项目最近 24 小时生成任务已达到配额 ${dailyLimit}，请稍后重试或联系管理员调整`, limit: dailyLimit, used });
      }
    }
    try {
      return await this.prisma.task.create({
        data: { sessionId, prompt, status: 'queued' },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({ code: 'GENERATION_ALREADY_ACTIVE', message: '当前会话已有生成任务正在执行' });
      }
      throw error;
    }
  }

  async getTask(userId: string, taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException({ code: 'GENERATION_TASK_NOT_FOUND', message: '任务不存在' });
    await this.access.requireSession(userId, task.sessionId, 'read');
    return task;
  }

  async listTasks(userId: string, sessionId: string, limit = 100) {
    await this.access.requireSession(userId, sessionId, 'read');
    const tasks = await this.prisma.task.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        id: true,
        prompt: true,
        status: true,
        resultLog: true,
        executorKind: true,
        executionNamespace: true,
        executionRef: true,
        failureCode: true,
        priority: true,
        resourceWaitCount: true,
        startedAt: true,
        createdAt: true,
        finishedAt: true,
      },
    });
    return tasks.reverse();
  }

  async listUserTasks(
    userId: string,
    options: GenerationTaskListQueryDto,
  ) {
    const search = options.search?.trim().slice(0, 200);
    const where = {
      session: { userId },
      ...(options.status ? { status: options.status } : {}),
      ...(search ? { prompt: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(options),
        select: {
          id: true,
          sessionId: true,
          prompt: true,
          status: true,
          resultLog: true,
          executorKind: true,
          executionNamespace: true,
          executionRef: true,
          failureCode: true,
          priority: true,
          resourceWaitCount: true,
          startedAt: true,
          createdAt: true,
          finishedAt: true,
          session: { select: { project: { select: { id: true, name: true, language: true } } } },
        },
      }),
      this.prisma.task.count({ where }),
    ]);
    return pageResult(items, total, options);
  }

  async listAllTasks(options: GenerationTaskListQueryDto) {
    const where: Prisma.TaskWhereInput = {
      ...(options.status ? { status: options.status } : {}),
      ...(options.teamId ? { session: { project: { teamId: options.teamId } } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        ...pageArgs(options),
        include: {
          session: {
            select: {
              user: { select: { id: true, username: true, displayName: true } },
              project: { select: { id: true, name: true, language: true, team: { select: { id: true, name: true } } } },
            },
          },
        },
      }),
      this.prisma.task.count({ where }),
    ]);
    return pageResult(items, total, options);
  }

  /** 最近一次生成的文件改动（= git HEAD 相对父提交的 diff，持久化）；会话隔离校验 */
  async getChanges(userId: string, sessionId: string): Promise<FileChange[]> {
    await this.access.requireSession(userId, sessionId, 'read');
    const workspace = await this.workspaces.ensureForSession(userId, sessionId);
    return this.git.headDiff(workspace.path);
  }
}

function short(input: unknown): string {
  const s = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}
