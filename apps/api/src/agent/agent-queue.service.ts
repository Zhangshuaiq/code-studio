import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, QueueEvents } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService, RunResult } from './agent.service';
import { AgentEvent } from './providers/generation-provider';
import { createGenerationQueueConnection, GenerationJob, GENERATION_QUEUE_NAME } from './generation-queue';
import { injectTraceContext } from '../observability/trace-context';

@Injectable()
export class AgentQueueService implements OnModuleInit, OnModuleDestroy {
  private queue!: Queue<GenerationJob, RunResult>;
  private events!: QueueEvents;
  private readonly closeConnections: Array<() => Promise<void>> = [];

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
  ) {}

  async onModuleInit() {
    const queueConnection = createGenerationQueueConnection(this.config);
    const eventsConnection = createGenerationQueueConnection(this.config);
    this.queue = new Queue(GENERATION_QUEUE_NAME, { connection: queueConnection.connection });
    this.events = new QueueEvents(GENERATION_QUEUE_NAME, { connection: eventsConnection.connection });
    for (const item of [queueConnection, eventsConnection]) if (item.close) this.closeConnections.push(item.close);
    await Promise.all([this.queue.waitUntilReady(), this.events.waitUntilReady()]);
  }

  async enqueue(userId: string, sessionId: string, prompt: string) {
    const task = await this.agent.createQueuedTask(userId, sessionId, prompt);
    try {
      const job = await this.queue.add(
        'generate',
        { taskId: task.id, userId, sessionId, prompt, traceContext: injectTraceContext() },
        {
          jobId: task.id,
          attempts: Math.max(1, Number(this.config.get('AGENT_JOB_ATTEMPTS', 2))),
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 24 * 3600, count: 2_000 },
          removeOnFail: { age: 7 * 24 * 3600, count: 5_000 },
          priority: task.priority,
        },
      );
      return { task, job };
    } catch (error) {
      await this.prisma.task.update({
        where: { id: task.id },
        data: { status: 'failed', resultLog: `任务入队失败: ${(error as Error).message}`, finishedAt: new Date() },
      });
      throw error;
    }
  }

  async waitFor(
    job: Job<GenerationJob, RunResult>,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ) {
    const progress = ({ jobId, data }: { jobId: string; data: unknown }) => {
      if (jobId === job.id && data && typeof data === 'object') {
        onEvent?.(data as AgentEvent);
      }
    };
    let removedReject: (error: Error) => void = () => undefined;
    const removedPromise = new Promise<never>((_, reject) => {
      removedReject = reject;
    });
    const removed = ({ jobId }: { jobId: string }) => {
      if (jobId === job.id) removedReject(new Error('任务已取消'));
    };
    let abortReject: (error: Error) => void = () => undefined;
    const abortedPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    const aborted = () => {
      const error = new Error('客户端流式连接已断开，任务继续在后台执行');
      error.name = 'GenerationStreamDisconnectedError';
      abortReject(error);
    };
    this.events.on('progress', progress);
    this.events.on('removed', removed);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    try {
      const timeout = Number(this.config.get('AGENT_JOB_TIMEOUT_MS', 30 * 60_000));
      return await Promise.race([
        job.waitUntilFinished(this.events, timeout),
        removedPromise,
        abortedPromise,
      ]);
    } finally {
      this.events.off('progress', progress);
      this.events.off('removed', removed);
      signal?.removeEventListener('abort', aborted);
    }
  }

  /** 连接中断后按持久化 taskId 恢复等待；任务不依赖原 HTTP 连接存活。 */
  async resume(
    userId: string,
    taskId: string,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const task = await this.agent.getTask(userId, taskId);
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(task.status)) {
      return {
        taskId: task.id,
        status: task.status === 'succeeded' ? 'succeeded' : 'failed',
        log: task.resultLog ?? '',
        events: [],
      };
    }
    const job = await this.queue.getJob(taskId);
    if (!job) {
      throw new ConflictException({
        code: 'GENERATION_JOB_MISSING',
        message: '任务仍未结束，但执行队列中已找不到对应任务',
      });
    }
    return this.waitFor(job, onEvent, signal);
  }

  async cancel(userId: string, taskId: string) {
    const task = await this.agent.getTask(userId, taskId);
    const job = await this.queue.getJob(taskId);
    if (!job) throw new ConflictException({ code: 'GENERATION_JOB_MISSING', message: '任务已不在执行队列中' });
    const state = await job.getState();
    if (state === 'active') {
      await this.prisma.task.update({ where: { id: taskId }, data: { status: 'cancelling', resultLog: '正在取消运行中的任务…' } });
      return { status: 'cancelling' };
    }
    await job.remove();
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'cancelled', resultLog: '任务已由用户取消', finishedAt: new Date() },
    });
    return { status: 'cancelled' };
  }

  async retry(userId: string, taskId: string) {
    const task = await this.agent.getTask(userId, taskId);
    if (!['failed', 'cancelled', 'timed_out'].includes(task.status)) {
      throw new ConflictException({ code: 'GENERATION_RETRY_NOT_ALLOWED', message: '只有失败、取消或超时任务可以重试', status: task.status });
    }
    return this.enqueue(userId, task.sessionId, task.prompt);
  }

  async adminCancel(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new ConflictException({ code: 'GENERATION_TASK_NOT_FOUND', message: '任务不存在' });
    if (!['queued', 'running', 'cancelling'].includes(task.status)) {
      throw new ConflictException({ code: 'GENERATION_TASK_FINISHED', message: '任务已经结束', status: task.status });
    }
    const job = await this.queue.getJob(taskId);
    const state = job ? await job.getState() : 'missing';
    if (state === 'active') {
      await this.prisma.task.update({
        where: { id: taskId },
        data: { status: 'cancelling', resultLog: '管理员正在强制终止任务…' },
      });
      return { status: 'cancelling' };
    }
    if (job) await job.remove();
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'cancelled', resultLog: '任务已由管理员终止', finishedAt: new Date() },
    });
    return { status: 'cancelled' };
  }

  async reprioritize(taskId: string, priority: number) {
    if (!Number.isInteger(priority) || priority < 1 || priority > 10) {
      throw new BadRequestException({ code: 'GENERATION_PRIORITY_INVALID', message: '优先级必须是 1 到 10 的整数，1 最高' });
    }
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.status !== 'queued') throw new ConflictException({ code: 'GENERATION_REPRIORITIZE_NOT_ALLOWED', message: '只有排队任务可以调整优先级', status: task?.status });
    const job = await this.queue.getJob(taskId);
    if (!job) throw new ConflictException({ code: 'GENERATION_JOB_MISSING', message: '任务已不在执行队列中' });
    const state = await job.getState();
    if (!['waiting', 'delayed', 'prioritized'].includes(state)) {
      throw new ConflictException({ code: 'GENERATION_REPRIORITIZE_NOT_ALLOWED', message: `任务当前处于 ${state}，不能调整优先级`, state });
    }
    await job.changePriority({ priority });
    await this.prisma.task.update({ where: { id: taskId }, data: { priority } });
    return { id: taskId, priority };
  }

  async health() {
    const startedAt = Date.now();
    try {
      await this.queue.waitUntilReady();
      const counts = await this.queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
      );
      const workerCount = await this.queue.getWorkersCount();
      return {
        available: workerCount > 0,
        redisAvailable: true,
        mode: this.config.get<string>('REDIS_MODE', 'standalone'),
        latencyMs: Date.now() - startedAt,
        queue: counts,
        workerCount,
        ...(workerCount === 0 ? { error: '没有可用的生成 Worker' } : {}),
      };
    } catch (error) {
      return { available: false, redisAvailable: false, mode: this.config.get<string>('REDIS_MODE', 'standalone'), latencyMs: Date.now() - startedAt, error: (error as Error).message };
    }
  }

  async listDeadLetters(page = 1, limit = 20) {
    const boundedPage = Math.max(1, page);
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const start = (boundedPage - 1) * boundedLimit;
    const [jobs, total] = await Promise.all([
      this.queue.getJobs('failed', start, start + boundedLimit - 1, false),
      this.queue.getFailedCount(),
    ]);
    const taskIds = jobs.map((job) => String(job.id));
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds } },
      select: { id: true, status: true, prompt: true, session: { select: { project: { select: { id: true, name: true } }, user: { select: { username: true } } } } },
    });
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return {
      items: jobs.map((job) => ({ id: String(job.id), failedReason: job.failedReason, attemptsMade: job.attemptsMade, processedOn: job.processedOn, finishedOn: job.finishedOn, task: taskById.get(String(job.id)) ?? null })),
      total,
      page: boundedPage,
      limit: boundedLimit,
      pages: Math.ceil(total / boundedLimit),
    };
  }

  async replayDeadLetter(jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job || (await job.getState()) !== 'failed') throw new ConflictException({ code: 'GENERATION_DEAD_LETTER_STALE', message: '死信任务不存在或状态已变化' });
    const task = await this.prisma.task.findUnique({ where: { id: jobId } });
    if (!task || task.status !== 'failed') throw new ConflictException({ code: 'GENERATION_DEAD_LETTER_REPLAY_NOT_ALLOWED', message: '仅执行失败的任务可以从死信队列重放', status: task?.status });
    const active = await this.prisma.task.count({ where: { sessionId: task.sessionId, status: { in: ['queued', 'running', 'cancelling'] } } });
    if (active) throw new ConflictException({ code: 'GENERATION_ALREADY_ACTIVE', message: '该会话已有活跃任务，暂不能重放' });
    await this.prisma.task.update({ where: { id: task.id }, data: { status: 'queued', resultLog: '管理员已从死信队列重放任务', finishedAt: null } });
    try {
      await job.retry('failed');
    } catch (error) {
      await this.prisma.task.update({ where: { id: task.id }, data: { status: 'failed', resultLog: `死信重放失败: ${(error as Error).message}`, finishedAt: new Date() } });
      throw error;
    }
    return { id: jobId, status: 'queued' };
  }

  async removeDeadLetter(jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job || (await job.getState()) !== 'failed') throw new ConflictException({ code: 'GENERATION_DEAD_LETTER_STALE', message: '死信任务不存在或状态已变化' });
    await job.remove();
    return { ok: true };
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.events?.close(),
      this.queue?.close(),
    ]);
    await Promise.allSettled(this.closeConnections.map((close) => close()));
  }
}
