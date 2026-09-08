import { Injectable } from '@nestjs/common';
import { PageQueryDto } from '../common/dto/page-query.dto';
import { ScheduledTaskListQueryDto } from '../scheduled-task/dto/scheduled-task.dto';
import { ScheduledTaskService } from '../scheduled-task/scheduled-task.service';

@Injectable()
export class ScheduledTaskMcpFacade {
  constructor(private readonly tasks: ScheduledTaskService) {}

  async applications() {
    const rows = await this.tasks.listApplications();
    return rows.map((application) => ({
      id: application.id,
      name: application.name,
      enabled: application.enabled,
      lastRegisteredAt: application.lastRegisteredAt,
      createdAt: application.createdAt,
      handlers: application.handlers.map((handler) => ({
        id: handler.id,
        methodName: handler.methodName,
        description: handler.description,
        riskLevel: handler.riskLevel,
        timeoutSeconds: handler.timeoutSeconds,
        allowConcurrent: handler.allowConcurrent,
        idempotent: handler.idempotent,
        version: handler.version,
        lastRegisteredAt: handler.lastRegisteredAt,
      })),
    }));
  }

  async list(input: { page: number; pageSize: number; status?: string }) {
    const result = await this.tasks.listTasks(Object.assign(new ScheduledTaskListQueryDto(), input));
    return {
      ...result,
      items: result.items.map((task) => ({
        id: task.id,
        name: task.name,
        application: task.application,
        handler: {
          id: task.handler.id,
          methodName: task.handler.methodName,
          description: task.handler.description,
          riskLevel: task.handler.riskLevel,
          version: task.handler.version,
        },
        scheduleType: task.scheduleType,
        cronExpression: task.cronExpression,
        timezone: task.timezone,
        executeAt: task.executeAt,
        nextRunAt: task.nextRunAt,
        status: task.status,
        concurrencyPolicy: task.concurrencyPolicy,
        timeoutSeconds: task.timeoutSeconds,
        maxRetries: task.maxRetries,
        createdByName: task.createdByName,
        approvedByName: task.approvedByName,
        approvedAt: task.approvedAt,
        expiresAt: task.expiresAt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        latestExecution: task.executions[0] ? executionSummary(task.executions[0]) : null,
      })),
    };
  }

  async executions(taskId: string, input: { page: number; pageSize: number }) {
    const result = await this.tasks.listExecutions(
      taskId,
      Object.assign(new PageQueryDto(), input),
    );
    return { ...result, items: result.items.map(executionSummary) };
  }
}

function executionSummary(execution: {
  id: string;
  status: string;
  triggerType: string;
  attempt: number;
  handlerVersion: string | null;
  scheduledAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
  traceId: string;
  createdAt: Date;
}) {
  return {
    id: execution.id,
    status: execution.status,
    triggerType: execution.triggerType,
    attempt: execution.attempt,
    handlerVersion: execution.handlerVersion,
    scheduledAt: execution.scheduledAt,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    heartbeatAt: execution.heartbeatAt,
    traceId: execution.traceId,
    createdAt: execution.createdAt,
  };
}
