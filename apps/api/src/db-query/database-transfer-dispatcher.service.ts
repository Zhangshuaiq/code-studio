import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbQueryService } from './db-query.service';

/** 数据库备份/迁移消费者，仅在独立 Worker 中装载。 */
@Injectable()
export class DatabaseTransferDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseTransferDispatcherService.name);
  private timer?: NodeJS.Timeout;
  private dispatching = false;

  constructor(private readonly queries: DbQueryService) {}

  onModuleInit() {
    void this.dispatch();
    this.timer = setInterval(() => void this.dispatch(), 2_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.queries.dispatchTransfer();
    } catch (error) {
      this.logger.error(`数据库传输调度失败: ${(error as Error).message}`);
    } finally {
      this.dispatching = false;
    }
  }
}
