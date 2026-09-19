import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Queue, UnrecoverableError, Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService, RunResult } from './agent.service';
import { createGenerationQueueConnection, GenerationJob, GENERATION_QUEUE_NAME } from './generation-queue';
import { GenerationSchedulerService } from './generation-scheduler.service';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { extractTraceContext } from '../observability/trace-context';
import { diagnosticMessage } from '../common/redact-diagnostic';
import { DistributedWorkspaceLockService } from '../workspace/distributed-workspace-lock.service';
import { WorkspaceStorageService } from '../workspace/workspace-storage.service';
import { scanWorkspaceUsage } from '../common/workspace-quota';
import { statfs } from 'node:fs/promises';

@Injectable()
export class AgentWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentWorkerService.name);
  private worker!: Worker<GenerationJob, RunResult>;
  private queue!: Queue<GenerationJob, RunResult>;
  private stopping = false;
  private delegated = false;
  private readonly closeConnections: Array<() => Promise<void>> = [];

  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService, private readonly agent: AgentService, private readonly scheduler: GenerationSchedulerService, private readonly workspaceLock: DistributedWorkspaceLockService, private readonly storage: WorkspaceStorageService) {}

  async onModuleInit() {
    if (this.config.get<string>('AGENT_WORKER_DEDICATED') === 'true' &&
        this.config.get<string>('PROCESS_ROLE') !== 'agent-worker') {
      this.delegated = true;
      this.logger.log('编码任务由独立 Agent Worker 领取');
      return;
    }
    const queueConnection = createGenerationQueueConnection(this.config);
    const workerConnection = createGenerationQueueConnection(this.config);
    this.queue = new Queue(GENERATION_QUEUE_NAME, { connection: queueConnection.connection });
    for (const item of [queueConnection, workerConnection]) if (item.close) this.closeConnections.push(item.close);
    await this.queue.waitUntilReady();
    await this.reconcileInterruptedTasks();
    this.worker = new Worker<GenerationJob, RunResult>(GENERATION_QUEUE_NAME, async (job) => context.with(extractTraceContext(job.data.traceContext), () => trace.getTracer('code-studio.queue').startActiveSpan('generation.process', { kind: SpanKind.CONSUMER, attributes: { 'messaging.system': 'redis', 'messaging.destination.name': GENERATION_QUEUE_NAME, 'messaging.message.id': String(job.id), 'code-studio.task.id': job.data.taskId } }, async (span) => {
      const admission = await this.scheduler.admit(job.data.taskId);
      if (!admission.admitted) {
        if (admission.limit === 0) throw new UnrecoverableError('任务已终止，不能再次调度');
        const delay = Number(this.config.get('GENERATION_RESOURCE_RETRY_MS', 5_000));
        await job.moveToDelayed(Date.now() + delay + Math.floor(Math.random() * 1_000), job.token);
        throw new DelayedError();
      }
      const controller = new AbortController();
      let eventSequence = 0;
      const timeout = setTimeout(() => controller.abort(namedError('TaskTimeoutError', '超过最大执行时间')), Number(this.config.get('AGENT_EXECUTION_TIMEOUT_MS', 30 * 60_000)));
      const cancellationPoll = setInterval(async () => {
        const task = await this.prisma.task.findUnique({ where: { id: job.data.taskId }, select: { status: true } }).catch(() => null);
        if (task?.status === 'cancelling') controller.abort(namedError('TaskCancelledError', '用户取消任务'));
      }, 1_000);
      cancellationPoll.unref();
      let resourcePoll: NodeJS.Timeout | undefined;
      try {
        const session = await this.prisma.session.findUnique({ where: { id: job.data.sessionId }, select: { projectId: true } });
        if (!session) throw new UnrecoverableError('生成任务关联的会话不存在');
        const project = await this.prisma.project.findUnique({ where: { id: session.projectId } });
        if (!project) throw new UnrecoverableError('生成任务关联的项目不存在');
        const workspacePath = this.storage.userPath(project, job.data.userId);
        const baseline = await scanWorkspaceUsage(workspacePath);
        const maxGrowthFiles = Number(this.config.get('AGENT_MAX_WORKSPACE_GROWTH_FILES', 20_000));
        const maxGrowthBytes = Number(this.config.get('AGENT_MAX_WORKSPACE_GROWTH_BYTES', 2 * 1024 * 1024 * 1024));
        const minFreeBytes = Number(this.config.get('AGENT_MIN_FREE_DISK_BYTES', 1024 * 1024 * 1024));
        let checking = false;
        const checkResources = async () => {
          if (checking || controller.signal.aborted) return;
          checking = true;
          try {
            const disk = await statfs(workspacePath);
            if (disk.bavail * disk.bsize < minFreeBytes) {
              controller.abort(namedError('WorkspaceResourceLimitError', '工作区磁盘剩余空间不足，已停止本次任务以保护共享存储'));
              return;
            }
            const usage = await scanWorkspaceUsage(workspacePath);
            if (usage.files - baseline.files > maxGrowthFiles || usage.bytes - baseline.bytes > maxGrowthBytes) {
              controller.abort(namedError('WorkspaceResourceLimitError', '本次任务写入量异常增长，已停止任务；已有文件不会被删除'));
            }
          } catch (error) {
            this.logger.warn(`工作区资源检测失败 job=${job.id}: ${diagnosticMessage(error)}`);
          } finally {
            checking = false;
          }
        };
        await checkResources();
        controller.signal.throwIfAborted();
        resourcePoll = setInterval(() => void checkResources(), 10_000);
        resourcePoll.unref();
        const result = await this.workspaceLock.runExclusive(
          `workspace:${session.projectId}:${job.data.userId}`,
          () => this.agent.runTask(job.data.userId, job.data.sessionId, job.data.prompt, (event) => void job.updateProgress({ ...event, sequence: job.attemptsMade * 1_000_000 + ++eventSequence }), job.data.taskId, controller.signal),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error); span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        if (controller.signal.aborted) {
          throw new UnrecoverableError(
            controller.signal.reason instanceof Error ? controller.signal.reason.message : error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        clearInterval(cancellationPoll);
        if (resourcePoll) clearInterval(resourcePoll);
        span.end();
      }
    })), {
        connection: workerConnection.connection,
        concurrency: Math.max(1, Number(this.config.get('AGENT_WORKER_CONCURRENCY', 2))),
        lockDuration: Number(this.config.get('AGENT_JOB_LOCK_MS', 600_000)),
      });
    this.worker.on('completed', (job) => this.logger.log(`生成任务完成 job=${job.id}`));
    this.worker.on('failed', async (job, error) => {
      const message = diagnosticMessage(error);
      this.logger.error(`生成队列任务失败 job=${job?.id}: ${message}`);
      if (!job) return;
      try {
        if ((await job.getState()) !== 'failed') return;
        await this.prisma.task.updateMany({ where: { id: job.data.taskId, status: { in: ['queued', 'running'] } }, data: { status: 'failed', resultLog: `任务在 ${job.attemptsMade} 次尝试后失败: ${message}`, finishedAt: new Date() } });
      } catch (syncError) {
        this.logger.error(`同步失败任务状态异常 job=${job.id}: ${diagnosticMessage(syncError)}`);
      }
    });
    this.logger.log(`独立生成 Worker 已就绪，并发数=${this.worker.opts.concurrency}`);
  }

  private async reconcileInterruptedTasks() {
    // 多副本下，其他 Pod 可能正在执行 running/cancelling 任务；启动新副本不得改写其状态。
    // BullMQ 自身负责 stalled job 恢复，这里只处理数据库里有排队记录而 Redis 已无任务的情况。
    const olderThan = new Date(Date.now() - 60_000);
    const tasks = await this.prisma.task.findMany({ where: { status: 'queued', createdAt: { lt: olderThan } }, select: { id: true, status: true } });
    for (const task of tasks) {
      const job = await this.queue.getJob(task.id);
      if (!job) await this.prisma.task.updateMany({
        where: { id: task.id, status: 'queued' },
        data: { status: 'failed', resultLog: 'Redis 中不存在对应任务，状态已自动校准。', finishedAt: new Date() },
      });
    }
  }

  async health() {
    if (this.delegated) return { available: true, status: 'delegated', redisMode: this.config.get<string>('REDIS_MODE', 'standalone') };
    if (this.stopping || !this.worker) {
      return { available: false, status: this.stopping ? 'stopping' : 'starting', redisMode: this.config.get<string>('REDIS_MODE', 'standalone') };
    }
    try {
      await Promise.race([
        this.worker.waitUntilReady(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Redis 健康检查超时')), 2_000),
        ),
      ]);
      const available = this.worker.isRunning() && !this.worker.isPaused();
      return { available, status: available ? 'ready' : 'paused', redisMode: this.config.get<string>('REDIS_MODE', 'standalone') };
    } catch (error) {
      return { available: false, status: 'disconnected', redisMode: this.config.get<string>('REDIS_MODE', 'standalone'), error: (error as Error).message };
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    this.logger.log('Worker 正在优雅停止，不再领取新任务并等待活跃任务结束');
    await this.worker?.pause(true);
    await Promise.allSettled([this.worker?.close(), this.queue?.close()]);
    await Promise.allSettled(this.closeConnections.map((close) => close()));
  }
}

function namedError(name: string, message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}
