import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { Audit } from '../audit/audit.decorator';
import { ScheduledTaskService } from './scheduled-task.service';
import { ChangeScheduledTaskStatusDto, CreateScheduledTaskDto, CreateTaskApplicationDto, RegisterJavaHandlersDto, RejectScheduledTaskDto, ScheduledTaskListQueryDto } from './dto/scheduled-task.dto';
import { PageQueryDto } from '../common/dto/page-query.dto';

@Controller('scheduled-tasks')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ScheduledTaskController {
  constructor(private readonly service: ScheduledTaskService) {}

  @Get('applications')
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_READ)
  applications() { return this.service.listApplications(); }

  @Get('queue/health')
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_READ)
  queueHealth() { return this.service.queueHealth(); }

  @Post('applications')
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_MANAGE)
  @Audit('scheduled-task.application.create', 'java-task-application')
  createApplication(@Body() body: CreateTaskApplicationDto) { return this.service.createApplication(body); }

  @Get()
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_READ)
  list(@Query() query: ScheduledTaskListQueryDto) { return this.service.listTasks(query); }

  @Post()
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_MANAGE)
  @Audit('scheduled-task.create', 'scheduled-java-task')
  create(@Body() body: CreateScheduledTaskDto, @CurrentUser() user: AuthUser) { return this.service.createTask(body, user); }

  @Post(':id/approve')
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_APPROVE)
  @Audit('scheduled-task.approve', 'scheduled-java-task')
  approve(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.service.approveTask(id, user); }

  @Post(':id/reject')
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_APPROVE)
  @Audit('scheduled-task.reject', 'scheduled-java-task')
  reject(@Param('id') id: string, @Body() body: RejectScheduledTaskDto) { return this.service.rejectTask(id, body.reason); }

  @Post(':id/run')
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_APPROVE)
  @Audit('scheduled-task.run', 'scheduled-java-task')
  run(@Param('id') id: string) { return this.service.runManually(id); }

  @Patch(':id/status')
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_MANAGE)
  @Audit('scheduled-task.status', 'scheduled-java-task')
  status(@Param('id') id: string, @Body() body: ChangeScheduledTaskStatusDto) { return this.service.changeStatus(id, body.status); }

  @Get(':id/executions')
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_READ)
  executions(@Param('id') id: string, @Query() query: PageQueryDto) { return this.service.listExecutions(id, query); }

  @Post('executions/:executionId/cancel')
  @RequirePermissions(PERMISSIONS.SCHEDULED_TASK_APPROVE)
  @Audit('scheduled-task.execution.cancel', 'java-task-execution')
  cancelExecution(@Param('executionId') executionId: string) { return this.service.cancelExecution(executionId); }
}

@Controller('internal/java-tasks')
export class JavaTaskRegistrationController {
  constructor(private readonly service: ScheduledTaskService) {}

  @Post('register')
  register(@Headers('x-application-name') name: string, @Headers('x-registration-token') token: string, @Body() body: RegisterJavaHandlersDto) {
    return this.service.registerHandlers(name, token, body);
  }
}
