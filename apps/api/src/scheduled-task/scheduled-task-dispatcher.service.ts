import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduledTaskService } from './scheduled-task.service';

/** 仅由 WorkerAppModule 装载，API 副本不再轮询到期任务。 */
@Injectable()
export class ScheduledTaskDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledTaskDispatcherService.name);
  private timer?: NodeJS.Timeout;
  private dispatching = false;

  constructor(
    private readonly tasks: ScheduledTaskService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('SCHEDULED_TASK_DISPATCHER_ENABLED', 'true') !== 'true') return;
    void this.dispatch();
    this.timer = setInterval(() => void this.dispatch(), 5_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.tasks.dispatchDueTasks();
    } catch (error) {
      this.logger.error(`Java 定时任务调度失败: ${(error as Error).message}`);
    } finally {
      this.dispatching = false;
    }
  }
}
