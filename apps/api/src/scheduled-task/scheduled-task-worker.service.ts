import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduledTaskService } from './scheduled-task.service';
import { createScheduledTaskQueueConnection, ScheduledTaskJob, SCHEDULED_TASK_QUEUE_NAME } from './scheduled-task-queue';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { extractTraceContext } from '../observability/trace-context';

@Injectable()
export class ScheduledTaskWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledTaskWorkerService.name);
  private worker!: Worker<ScheduledTaskJob>;
  private queue!: Queue<ScheduledTaskJob>;
  private closeConnections: Array<() => Promise<void>> = [];
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService, private readonly tasks: ScheduledTaskService) {}

  async onModuleInit() {
    const connection = createScheduledTaskQueueConnection(this.config);
    const queueConnection = createScheduledTaskQueueConnection(this.config);
    this.closeConnections.push(connection.close, queueConnection.close);
    this.queue = new Queue(SCHEDULED_TASK_QUEUE_NAME, { connection: queueConnection.connection });
    this.worker = new Worker(SCHEDULED_TASK_QUEUE_NAME, async (job) => context.with(extractTraceContext(job.data.traceContext), () => trace.getTracer('code-studio.queue').startActiveSpan('java-scheduled-task.process', { kind: SpanKind.CONSUMER, attributes: { 'messaging.system': 'redis', 'messaging.destination.name': SCHEDULED_TASK_QUEUE_NAME, 'messaging.message.id': String(job.id), 'code-studio.execution.id': job.data.executionId } }, async (span) => {
      const controller = new AbortController();
      const poll = setInterval(async () => {
        const execution = await this.prisma.javaTaskExecution.findUnique({ where: { id: job.data.executionId }, select: { status: true } }).catch(() => null);
        if (execution?.status === 'cancelling' || execution?.status === 'cancelled') controller.abort(new Error('用户取消任务'));
      }, 1000); poll.unref();
      try { const result = await this.tasks.processExecution(job.data.executionId, job.attemptsMade + 1, job.attemptsMade + 1 >= (job.opts.attempts || 1), controller.signal); span.setStatus({ code: SpanStatusCode.OK }); return result; }
      catch (error) { span.recordException(error as Error); span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message }); throw error; }
      finally { clearInterval(poll); span.end(); }
    })), { connection: connection.connection, concurrency: Math.max(1, Number(this.config.get('SCHEDULED_TASK_WORKER_CONCURRENCY', 4))), lockDuration: 60_000 });
    this.worker.on('completed', (job) => this.logger.log(`Java 定时任务完成 execution=${job.id}`));
    this.worker.on('failed', (job, error) => this.logger.warn(`Java 定时任务尝试失败 execution=${job?.id}: ${error.message}`));
    await this.worker.waitUntilReady();
    await this.reconcile();
    this.logger.log(`Java 定时任务 Worker 已就绪，并发数=${this.worker.opts.concurrency}`);
  }
  private async reconcile() {
    const interrupted = await this.prisma.javaTaskExecution.findMany({ where: { status: { in: ['queued', 'running'] } }, select: { id: true } });
    for (const execution of interrupted) {
      const job = await this.queue.getJob(execution.id);
      await this.prisma.javaTaskExecution.update({ where: { id: execution.id }, data: job ? { status: 'queued' } : { status: 'failed', error: 'Worker 恢复时未在 Redis 中找到对应任务', finishedAt: new Date() } });
    }
  }
  async health() { return { available: !!this.worker?.isRunning() && !this.worker.isPaused(), status: this.worker?.isRunning() ? 'ready' : 'starting' }; }
  async onModuleDestroy() { await Promise.allSettled([this.worker?.close(), this.queue?.close()]); await Promise.allSettled(this.closeConnections.map((close) => close())); }
}
