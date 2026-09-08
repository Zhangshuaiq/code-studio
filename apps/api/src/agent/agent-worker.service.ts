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
import { WorkspaceService } from '../workspace/workspace.service';

@Injectable()
export class AgentWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentWorkerService.name);
  private worker!: Worker<GenerationJob, RunResult>;
  private queue!: Queue<GenerationJob, RunResult>;
  private stopping = false;
  private readonly closeConnections: Array<() => Promise<void>> = [];

  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService, private readonly agent: AgentService, private readonly scheduler: GenerationSchedulerService, private readonly workspaceLock: DistributedWorkspaceLockService, private readonly workspaces: WorkspaceService) {}

  async onModuleInit() {
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
      const timeout = setTimeout(() => controller.abort(namedError('TaskTimeoutError', '超过最大执行时间')), Number(this.config.get('AGENT_EXECUTION_TIMEOUT_MS', 30 * 60_000)));
      const cancellationPoll = setInterval(async () => {
        const task = await this.prisma.task.findUnique({ where: { id: job.data.taskId }, select: { status: true } }).catch(() => null);
        if (task?.status === 'cancelling') controller.abort(namedError('TaskCancelledError', '用户取消任务'));
      }, 1_000);
      cancellationPoll.unref();
      try {
        const session = await this.prisma.session.findUnique({ where: { id: job.data.sessionId }, select: { projectId: true } });
        if (!session) throw new UnrecoverableError('生成任务关联的会话不存在');
        await this.workspaces.ensureForSession(job.data.userId, job.data.sessionId);
        const result = await this.workspaceLock.runExclusive(
          `workspace:${session.projectId}:${job.data.userId}`,
          () => this.agent.runTask(job.data.userId, job.data.sessionId, job.data.prompt, (event) => void job.updateProgress(event), job.data.taskId, controller.signal),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error); span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        if (controller.signal.aborted) {
          throw new UnrecoverableError(
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        clearInterval(cancellationPoll);
        span.end();
      }
    })), {
        connection: workerConnection.connection,
        concurrency: Math.max(1, Number(this.config.get('AGENT_WORKER_CONCURRENCY', 2))),
        lockDuration: Number(this.config.get('AGENT_JOB_LOCK_MS', 600_000)),
      });
    this.worker.on('completed', (job) => this.logger.log(`生成任务完成 job=${job.id}`));
    this.worker.on('failed', (job, error) => {
      const message = diagnosticMessage(error);
      this.logger.error(`生成队列任务失败 job=${job?.id}: ${message}`);
      if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
      void this.prisma.task.updateMany({ where: { id: job.data.taskId, status: { in: ['queued', 'running'] } }, data: { status: 'failed', resultLog: `任务在 ${job.attemptsMade} 次尝试后失败: ${message}`, finishedAt: new Date() } });
    });
    this.logger.log(`独立生成 Worker 已就绪，并发数=${this.worker.opts.concurrency}`);
  }

  private async reconcileInterruptedTasks() {
    const tasks = await this.prisma.task.findMany({ where: { status: { in: ['queued', 'running', 'cancelling'] } }, select: { id: true, status: true } });
    for (const task of tasks) {
      const job = await this.queue.getJob(task.id);
      if (task.status === 'cancelling') {
        if (job) await job.remove().catch(() => undefined);
        await this.prisma.task.update({ where: { id: task.id }, data: { status: 'cancelled', resultLog: 'Worker 重启时完成取消', finishedAt: new Date() } });
        continue;
      }
      await this.prisma.task.update({ where: { id: task.id }, data: job ? { status: 'queued', finishedAt: null } : { status: 'failed', resultLog: 'Redis 中不存在对应任务，状态已自动校准。', finishedAt: new Date() } });
    }
  }

  async health() {
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
