import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { AgentService } from './agent.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { getRuntime } from '../sandbox/language-runtime';
import { PrismaService } from '../prisma/prisma.service';
import { RunTaskDto } from './dto/run-task.dto';
import { GenerationTaskListQueryDto, TaskPriorityDto } from './dto/task-admin.dto';
import { NotFoundException } from '@nestjs/common';
import { ProjectAccessService } from '../project-access/project-access.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { AgentQueueService } from './agent-queue.service';
import { Audit } from '../audit/audit.decorator';
import { Delete } from '@nestjs/common';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.GENERATE)
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly queue: AgentQueueService,
    private readonly sandbox: SandboxService,
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  /** 发一句话 → 在沙箱里生成/修改项目（同步返回，兼容旧调用） */
  @Post('run')
  async run(@CurrentUser() user: AuthUser, @Body() dto: RunTaskDto) {
    const { job } = await this.queue.enqueue(
      user.id,
      dto.sessionId,
      dto.prompt,
    );
    return this.queue.waitFor(job);
  }

  /** 流式生成：SSE 实时把生成过程逐条推给前端（对话/日志实时可见） */
  @Post('run/stream')
  async runStream(
    @CurrentUser() user: AuthUser,
    @Body() dto: RunTaskDto,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 关掉反代缓冲
    res.flushHeaders?.();

    const connection = new AbortController();
    res.on('close', () => connection.abort());
    res.write('retry: 3000\n\n');
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref();
    const send = (obj: unknown) => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };
    try {
      const { task, job } = await this.queue.enqueue(
        user.id,
        dto.sessionId,
        dto.prompt,
      );
      send({ type: 'queued', taskId: task.id });
      const result = await this.queue.waitFor(
        job,
        (e) => send({ type: 'event', event: e }),
        connection.signal,
      );
      send({
        type: 'done',
        taskId: result.taskId,
        status: result.status,
        log: result.log,
      });
    } catch (err) {
      if ((err as Error)?.name !== 'GenerationStreamDisconnectedError') {
        send({ type: 'error', message: (err as Error)?.message ?? '生成失败' });
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  }

  @Get('tasks/:id')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  task(@CurrentUser() user: AuthUser, @Param('id') taskId: string) {
    return this.agent.getTask(user.id, taskId);
  }

  /** SSE 断线恢复：重新订阅已有任务，不会重复创建生成任务。 */
  @Get('tasks/:id/stream')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  async resumeStream(
    @CurrentUser() user: AuthUser,
    @Param('id') taskId: string,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const connection = new AbortController();
    res.on('close', () => connection.abort());
    res.write('retry: 3000\n\n');
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref();
    const send = (obj: unknown) => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };
    try {
      const result = await this.queue.resume(
        user.id,
        taskId,
        (event) => send({ type: 'event', event }),
        connection.signal,
      );
      send({
        type: 'done',
        taskId: result.taskId,
        status: result.status,
        log: result.log,
      });
    } catch (error) {
      if ((error as Error)?.name !== 'GenerationStreamDisconnectedError') {
        send({
          type: 'error',
          message: (error as Error)?.message ?? '恢复任务流失败',
        });
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  }

  @Get('admin/tasks')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  adminTasks(
    @Query() query: GenerationTaskListQueryDto,
  ) {
    return this.agent.listAllTasks(query);
  }

  @Post('admin/tasks/:id/cancel')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  @Audit('agent.task.admin-cancel', 'generation-task')
  adminCancel(@Param('id') taskId: string) {
    return this.queue.adminCancel(taskId);
  }

  @Post('admin/tasks/:id/priority')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  @Audit('agent.task.reprioritize', 'generation-task')
  reprioritize(@Param('id') taskId: string, @Body() body: TaskPriorityDto) {
    return this.queue.reprioritize(taskId, Number(body.priority));
  }

  @Get('tasks')
  tasksCenter(
    @CurrentUser() user: AuthUser,
    @Query() query: GenerationTaskListQueryDto,
  ) {
    return this.agent.listUserTasks(user.id, query);
  }

  @Get('sessions/:id/tasks')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  tasks(
    @CurrentUser() user: AuthUser,
    @Param('id') sessionId: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : 100;
    return this.agent.listTasks(user.id, sessionId, limit);
  }

  @Post('tasks/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') taskId: string) {
    return this.queue.cancel(user.id, taskId);
  }

  @Post('tasks/:id/retry')
  async retry(@CurrentUser() user: AuthUser, @Param('id') taskId: string) {
    const { task } = await this.queue.retry(user.id, taskId);
    return { taskId: task.id, status: 'queued' };
  }

  @Get('dlq')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  deadLetters(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.queue.listDeadLetters(Number(page) || 1, Number(limit) || 20);
  }

  @Post('dlq/:id/replay')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  @Audit('agent.dlq.replay', 'generation-task')
  replayDeadLetter(@Param('id') jobId: string) {
    return this.queue.replayDeadLetter(jobId);
  }

  @Delete('dlq/:id')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  @Audit('agent.dlq.remove', 'generation-task')
  removeDeadLetter(@Param('id') jobId: string) {
    return this.queue.removeDeadLetter(jobId);
  }

  /** 最近一次生成改动的文件（含 before/after，用于前端 diff） */
  @Get('sessions/:id/changes')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  changes(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    return this.agent.getChanges(user.id, sessionId);
  }

  /** 在容器内构建生成的项目（mvn clean package -DskipTests） */
  @Post('sessions/:id/build')
  async build(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    const session = await this.requireSession(user.id, sessionId);
    const runtime = getRuntime(session.project.language);
    if (!runtime.buildCommand) {
      throw new NotFoundException(
        `${runtime.displayName} 未定义构建命令`,
      );
    }
    const result = await this.sandbox.exec(sessionId, [
      'sh',
      '-c',
      runtime.buildCommand,
    ]);
    return { command: runtime.buildCommand, ...result };
  }

  private async requireSession(userId: string, sessionId: string) {
    return this.access.requireSession(userId, sessionId, 'edit');
  }
}
