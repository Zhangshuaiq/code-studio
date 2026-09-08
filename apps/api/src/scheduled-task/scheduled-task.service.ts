import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { CronExpressionParser } from 'cron-parser';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuthUser } from '../auth/jwt.strategy';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createScheduledTaskQueueConnection, ScheduledTaskJob, SCHEDULED_TASK_QUEUE_NAME } from './scheduled-task-queue';
import { injectTraceContext } from '../observability/trace-context';
import { CreateScheduledTaskDto, CreateTaskApplicationDto, RegisterJavaHandlersDto, ScheduledTaskListQueryDto } from './dto/scheduled-task.dto';
import { PageQueryDto, pageArgs, pageResult } from '../common/dto/page-query.dto';
import { Prisma } from '@prisma/client';

type RunnableTask = Prisma.ScheduledJavaTaskGetPayload<{ include: { handler: true; application: true } }>;

@Injectable()
export class ScheduledTaskService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledTaskService.name);
  private queue!: Queue<ScheduledTaskJob>;
  private closeQueueConnection?: () => Promise<void>;

  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly config: ConfigService) {}

  async onModuleInit() {
    const queueConnection = createScheduledTaskQueueConnection(this.config);
    this.closeQueueConnection = queueConnection.close;
    this.queue = new Queue(SCHEDULED_TASK_QUEUE_NAME, { connection: queueConnection.connection });
    await this.queue.waitUntilReady();
  }
  async onModuleDestroy() { await this.queue?.close(); await this.closeQueueConnection?.(); }

  listApplications() {
    return this.prisma.javaTaskApplication.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, baseUrl: true, enabled: true, lastRegisteredAt: true, createdAt: true, handlers: { where: { enabled: true }, orderBy: { methodName: 'asc' } } } });
  }

  async createApplication(input: CreateTaskApplicationDto) {
    const name = requiredText(input.name, '应用名称');
    const baseUrl = validateUrl(input.baseUrl);
    const token = typeof input.token === 'string' && input.token.length >= 16 ? input.token : randomBytes(24).toString('hex');
    const application = await this.prisma.javaTaskApplication.create({ data: { name, baseUrl, encryptedToken: this.crypto.encrypt(token) }, select: { id: true, name: true, baseUrl: true, enabled: true, createdAt: true } });
    return { ...application, registrationToken: token };
  }

  async registerHandlers(name: string, token: string, input: RegisterJavaHandlersDto) {
    const app = await this.prisma.javaTaskApplication.findUnique({ where: { name } });
    if (!app || !app.enabled || !secureEqual(token || '', this.crypto.decrypt(app.encryptedToken))) throw new UnauthorizedException({ code: 'JAVA_TASK_REGISTRATION_INVALID', message: 'Java 应用注册凭据无效' });
    if (!Array.isArray(input.handlers) || !input.handlers.length || input.handlers.length > 200) throw new BadRequestException('handlers 必须包含 1-200 个方法');
    const now = new Date();
    for (const raw of input.handlers) {
      const methodName = requiredText(raw.methodName, '方法名称');
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{2,127}$/.test(methodName)) throw new BadRequestException(`方法名称非法: ${methodName}`);
      await this.prisma.javaTaskHandler.upsert({ where: { applicationId_methodName: { applicationId: app.id, methodName } }, create: { applicationId: app.id, methodName, description: optionalText(raw.description), parameterSchema: jsonObject(raw.parameterSchema, {}), riskLevel: risk(raw.riskLevel), timeoutSeconds: intRange(raw.timeoutSeconds, 1, 3600, 300), allowConcurrent: raw.allowConcurrent ?? false, idempotent: raw.idempotent ?? false, version: optionalText(input.version), lastRegisteredAt: now }, update: { description: optionalText(raw.description), parameterSchema: jsonObject(raw.parameterSchema, {}), riskLevel: risk(raw.riskLevel), timeoutSeconds: intRange(raw.timeoutSeconds, 1, 3600, 300), allowConcurrent: raw.allowConcurrent ?? false, idempotent: raw.idempotent ?? false, version: optionalText(input.version), enabled: true, lastRegisteredAt: now } });
    }
    await this.prisma.javaTaskApplication.update({ where: { id: app.id }, data: { lastRegisteredAt: now, ...(input.baseUrl ? { baseUrl: validateUrl(input.baseUrl) } : {}) } });
    return { registered: input.handlers.length, registeredAt: now };
  }

  async listTasks(query: ScheduledTaskListQueryDto) {
    const where = query.status ? { status: query.status } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.scheduledJavaTask.findMany({ where, ...pageArgs(query), include: { application: { select: { id: true, name: true } }, handler: true, executions: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.scheduledJavaTask.count({ where }),
    ]);
    return pageResult(items, total, query);
  }

  async createTask(input: CreateScheduledTaskDto, user: AuthUser) {
    const handler = await this.prisma.javaTaskHandler.findUnique({ where: { id: requiredText(input.handlerId, '任务方法') }, include: { application: true } });
    if (!handler || !handler.enabled || !handler.application.enabled) throw new NotFoundException({ code: 'JAVA_TASK_HANDLER_UNAVAILABLE', message: 'Java 任务方法不存在或已停用' });
    const scheduleType = ['immediate', 'once', 'cron'].includes(input.scheduleType) ? input.scheduleType : 'immediate';
    const timezone = optionalText(input.timezone) || 'Asia/Shanghai';
    let executeAt: Date | null = null; let cronExpression: string | null = null; let nextRunAt: Date | null = null;
    if (scheduleType === 'once') { executeAt = validFutureDate(input.executeAt); nextRunAt = executeAt; }
    if (scheduleType === 'cron') { cronExpression = requiredText(input.cronExpression, 'Cron 表达式'); nextRunAt = nextCron(cronExpression, timezone); }
    if (scheduleType === 'immediate') nextRunAt = new Date();
    return this.prisma.scheduledJavaTask.create({ data: { name: requiredText(input.name, '任务名称'), applicationId: handler.applicationId, handlerId: handler.id, parameters: jsonObject(input.parameters, {}), scheduleType, cronExpression, timezone, executeAt, nextRunAt, concurrencyPolicy: input.concurrencyPolicy === 'allow' && handler.allowConcurrent ? 'allow' : 'forbid', timeoutSeconds: intRange(input.timeoutSeconds, 1, 3600, handler.timeoutSeconds), maxRetries: handler.idempotent ? intRange(input.maxRetries, 0, 5, 0) : 0, createdById: user.id, createdByName: user.username, expiresAt: input.expiresAt ? validFutureDate(input.expiresAt) : null }, include: { application: true, handler: true } });
  }

  async approveTask(id: string, user: AuthUser) {
    const task = await this.prisma.scheduledJavaTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException({ code: 'SCHEDULED_TASK_NOT_FOUND', message: '任务不存在' });
    if (task.createdById === user.id) throw new ForbiddenException({ code: 'APPROVAL_SELF_REVIEW_FORBIDDEN', message: '任务创建人不能审批自己的定时任务' });
    if (task.status !== 'pending_approval') throw new ConflictException({ code: 'SCHEDULED_TASK_STATE_CONFLICT', message: '任务已被处理' });
    return this.prisma.scheduledJavaTask.update({ where: { id }, data: { status: 'enabled', approvedById: user.id, approvedByName: user.username, approvedAt: new Date() } });
  }
  async rejectTask(id: string, reason?: string) {
    const changed = await this.prisma.scheduledJavaTask.updateMany({ where: { id, status: 'pending_approval' }, data: { status: 'rejected' } });
    if (!changed.count) throw new ConflictException({ code: 'SCHEDULED_TASK_STATE_CONFLICT', message: '任务不存在或已被处理' });
    return { id, status: 'rejected', reason: optionalText(reason) };
  }
  async changeStatus(id: string, status: string) {
    if (!['enabled', 'paused'].includes(status)) throw new BadRequestException('仅支持启用或暂停');
    const task = await this.prisma.scheduledJavaTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException({ code: 'SCHEDULED_TASK_NOT_FOUND', message: '任务不存在' });
    if (!task.approvedAt) throw new ConflictException({ code: 'SCHEDULED_TASK_NOT_APPROVED', message: '任务尚未审批' });
    return this.prisma.scheduledJavaTask.update({ where: { id }, data: { status, ...(status === 'enabled' && task.scheduleType === 'cron' && task.cronExpression ? { nextRunAt: nextCron(task.cronExpression, task.timezone) } : {}) } });
  }
  async listExecutions(taskId: string, query: PageQueryDto) {
    const where = { taskId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.javaTaskExecution.findMany({ where, ...pageArgs(query), orderBy: { createdAt: 'desc' } }),
      this.prisma.javaTaskExecution.count({ where }),
    ]);
    return pageResult(items, total, query);
  }
  async cancelExecution(executionId: string) {
    const execution = await this.prisma.javaTaskExecution.findUnique({ where: { id: executionId } });
    if (!execution) throw new NotFoundException({ code: 'SCHEDULED_TASK_EXECUTION_NOT_FOUND', message: '执行实例不存在' });
    if (!['queued', 'running', 'cancelling'].includes(execution.status)) throw new ConflictException({ code: 'SCHEDULED_TASK_EXECUTION_FINISHED', message: '执行实例已经结束' });
    const job = await this.queue.getJob(executionId);
    const state = job ? await job.getState() : 'missing';
    if (state === 'active') {
      await this.prisma.javaTaskExecution.update({ where: { id: executionId }, data: { status: 'cancelling', error: '正在请求 Worker 取消任务' } });
      return { id: executionId, status: 'cancelling' };
    }
    if (job) await job.remove();
    await this.prisma.javaTaskExecution.update({ where: { id: executionId }, data: { status: 'cancelled', error: '任务已由用户取消', finishedAt: new Date() } });
    return { id: executionId, status: 'cancelled' };
  }
  async runManually(id: string) {
    const task = await this.loadRunnable(id);
    const execution = await this.createExecution(task, 'manual');
    await this.enqueueExecution(execution.id, task.maxRetries);
    return execution;
  }

  async dispatchDueTasks() {
      const now = new Date();
      await this.prisma.scheduledJavaTask.updateMany({ where: { status: { in: ['enabled', 'paused'] }, expiresAt: { lte: now } }, data: { status: 'expired', nextRunAt: null } });
      const due = await this.prisma.scheduledJavaTask.findMany({ where: { status: 'enabled', nextRunAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, take: 50, orderBy: { nextRunAt: 'asc' }, include: { handler: true, application: true } });
      for (const task of due) {
        const next = task.scheduleType === 'cron' && task.cronExpression ? nextCron(task.cronExpression, task.timezone) : null;
        const claimed = await this.prisma.scheduledJavaTask.updateMany({ where: { id: task.id, status: 'enabled', nextRunAt: { lte: new Date() } }, data: next ? { nextRunAt: next } : { nextRunAt: null, status: 'completed' } });
        if (!claimed.count) continue;
        try {
          const execution = await this.createExecution(task, 'schedule');
          await this.enqueueExecution(execution.id, task.maxRetries);
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          this.logger.warn(`跳过并发执行 task=${task.id}: ${error.message}`);
        }
      }
  }

  private loadRunnable(id: string) {
    return this.prisma.scheduledJavaTask.findFirst({ where: { id, status: { in: ['enabled', 'completed'] }, approvedAt: { not: null } }, include: { handler: true, application: true } }).then((task) => { if (!task) throw new ConflictException({ code: 'SCHEDULED_TASK_NOT_RUNNABLE', message: '任务尚未审批或不可执行' }); return task; });
  }
  private async createExecution(task: RunnableTask, triggerType: 'manual' | 'schedule') {
    if (task.concurrencyPolicy === 'forbid') {
      const running = await this.prisma.javaTaskExecution.findFirst({ where: { taskId: task.id, status: { in: ['queued', 'running'] } } });
      if (running) throw new ConflictException({ code: 'SCHEDULED_TASK_ALREADY_RUNNING', message: '已有任务实例正在执行' });
    }
    return this.prisma.javaTaskExecution.create({ data: { taskId: task.id, triggerType, parametersSnapshot: task.parameters, handlerVersion: task.handler.version, scheduledAt: new Date(), traceId: randomUUID() } });
  }
  private async enqueueExecution(executionId: string, maxRetries: number) {
    try {
      await this.queue.add('execute-java-task', { executionId, traceContext: injectTraceContext() }, { jobId: executionId, attempts: maxRetries + 1, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 24 * 3600, count: 5000 }, removeOnFail: { age: 7 * 24 * 3600, count: 10000 } });
    } catch (error) {
      await this.prisma.javaTaskExecution.update({ where: { id: executionId }, data: { status: 'failed', error: `任务入队失败: ${(error as Error).message}`, finishedAt: new Date() } });
      throw error;
    }
  }

  async processExecution(executionId: string, attempt: number, finalAttempt: boolean, cancellationSignal?: AbortSignal) {
    const execution = await this.prisma.javaTaskExecution.findUnique({ where: { id: executionId }, include: { task: { include: { handler: true, application: true } } } });
    if (!execution) return;
    const { task } = execution;
    if (execution.status === 'cancelled') throw new Error('任务已取消');
    await this.prisma.javaTaskExecution.update({ where: { id: executionId }, data: { status: 'running', attempt, startedAt: execution.startedAt || new Date(), heartbeatAt: new Date(), error: null } });
    try {
      const timeoutSignal = AbortSignal.timeout(task.timeoutSeconds * 1000);
      const signal = cancellationSignal ? AbortSignal.any([timeoutSignal, cancellationSignal]) : timeoutSignal;
      const response = await fetch(`${task.application.baseUrl.replace(/\/$/, '')}/internal/platform-tasks/execute`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.crypto.decrypt(task.application.encryptedToken)}`, 'idempotency-key': execution.id, 'x-trace-id': execution.traceId }, body: JSON.stringify({ executionId: execution.id, handler: task.handler.methodName, parameters: execution.parametersSnapshot, timeoutSeconds: task.timeoutSeconds }), signal });
      const body = jsonRecord(await response.json().catch(() => ({})));
      const message = typeof body.message === 'string' ? body.message.slice(0, 2000) : '';
      if (!response.ok || body.success === false) throw new Error(message || `Java 服务返回 HTTP ${response.status}`);
      await this.prisma.javaTaskExecution.update({ where: { id: executionId }, data: { status: 'succeeded', resultSummary: jsonObject(body.summary, { message: message || '执行成功' }), finishedAt: new Date(), heartbeatAt: new Date() } });
    } catch (error) {
      const cancelled = cancellationSignal?.aborted;
      const timedOut = !cancelled && (error as Error).name === 'TimeoutError';
      await this.prisma.javaTaskExecution.update({ where: { id: executionId }, data: finalAttempt || cancelled ? { status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed', error: String((error as Error).message).slice(0, 10000), finishedAt: new Date() } : { status: 'queued', error: `第 ${attempt} 次执行失败，等待队列重试: ${String((error as Error).message).slice(0, 9000)}` } });
      throw error;
    }
  }

  async queueHealth() {
    try {
      const [counts, workerCount] = await Promise.all([this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed'), this.queue.getWorkersCount()]);
      return { available: workerCount > 0, workerCount, queue: counts };
    } catch (error) { return { available: false, workerCount: 0, error: (error as Error).message }; }
  }
}

function requiredText(value: unknown, label: string) { if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${label}不能为空`); return value.trim().slice(0, 200); }
function optionalText(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 1000) : null; }
function jsonRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function jsonObject(value: unknown, fallback: Record<string, unknown>): Prisma.InputJsonObject { return (Object.keys(jsonRecord(value)).length ? value : fallback) as Prisma.InputJsonObject; }
function intRange(value: unknown, min: number, max: number, fallback: number) { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; }
function risk(value: unknown) { return ['low', 'medium', 'high'].includes(String(value)) ? String(value) : 'medium'; }
function validateUrl(value: unknown) { const text = requiredText(value, '服务地址'); let url: URL; try { url = new URL(text); } catch { throw new BadRequestException('服务地址格式非法'); } if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestException('服务地址仅支持 HTTP/HTTPS'); return url.toString().replace(/\/$/, ''); }
function validFutureDate(value: unknown) { const date = new Date(String(value)); if (!Number.isFinite(date.getTime()) || date <= new Date()) throw new BadRequestException('执行时间必须是未来的有效时间'); return date; }
function nextCron(expression: string, timezone: string) { try { return CronExpressionParser.parse(expression, { currentDate: new Date(), tz: timezone }).next().toDate(); } catch (error) { throw new BadRequestException(`Cron 表达式非法: ${(error as Error).message}`); } }
function secureEqual(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
