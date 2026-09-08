import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceService } from '../workspace/workspace.service';

/** 仅由 Worker 装载；通过数据库状态 claim 项目资源回收任务。 */
@Injectable()
export class ProjectCleanupWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectCleanupWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspaceService,
    private readonly config: ConfigService,
  ) {
    this.maxAttempts = Number(this.config.get('PROJECT_CLEANUP_MAX_ATTEMPTS', 10));
  }

  onModuleInit() {
    if (this.config.get<string>('PROJECT_CLEANUP_WORKER_ENABLED', 'true') !== 'true') return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const interruptedImportBefore = new Date(Date.now() - 30 * 60_000);
      await this.prisma.project.updateMany({
        where: { status: 'importing', createdAt: { lt: interruptedImportBefore } },
        data: {
          status: 'deleting',
          deletionNextAttemptAt: new Date(),
          deletionError: 'Git 导入超过 30 分钟未完成，已转入资源回收',
        },
      });
      const staleBefore = new Date(Date.now() - 10 * 60_000);
      await this.prisma.project.updateMany({
        where: { status: 'deleting_cleanup', deletionStartedAt: { lt: staleBefore } },
        data: {
          status: 'deleting',
          deletionNextAttemptAt: new Date(),
          deletionError: '上一次资源回收中断，已重新进入队列',
        },
      });
      const candidate = await this.prisma.project.findFirst({
        where: {
          status: 'deleting',
          OR: [{ deletionNextAttemptAt: null }, { deletionNextAttemptAt: { lte: new Date() } }],
        },
        orderBy: { deletionNextAttemptAt: 'asc' },
        select: { id: true, volumePath: true, deletionAttempts: true },
      });
      if (!candidate) return;
      const claimed = await this.prisma.project.updateMany({
        where: { id: candidate.id, status: 'deleting' },
        data: {
          status: 'deleting_cleanup',
          deletionStartedAt: new Date(),
          deletionNextAttemptAt: null,
          deletionError: null,
        },
      });
      if (!claimed.count) return;
      try {
        await this.workspaces.removeProjectFiles(candidate.id, candidate.volumePath);
        await this.prisma.project.delete({ where: { id: candidate.id } });
        this.logger.log(`项目资源回收完成 project=${candidate.id}`);
      } catch (error) {
        const message = String((error as Error).message).slice(0, 10_000);
        const attempts = candidate.deletionAttempts + 1;
        const exhausted = attempts >= this.maxAttempts;
        const retryDelayMs = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 6));
        await this.prisma.project.updateMany({
          where: { id: candidate.id, status: 'deleting_cleanup' },
          data: {
            status: exhausted ? 'deletion_failed' : 'deleting',
            deletionAttempts: attempts,
            deletionError: message,
            deletionStartedAt: null,
            deletionNextAttemptAt: exhausted ? null : new Date(Date.now() + retryDelayMs),
            ...(exhausted ? {
              deletionAcknowledgedAt: null,
              deletionAcknowledgedById: null,
              deletionAcknowledgedByName: null,
              deletionAcknowledgementNote: null,
            } : {}),
          },
        }).catch(() => undefined);
        this.logger.error(`项目资源回收失败 project=${candidate.id} attempt=${attempts}/${this.maxAttempts}: ${message}`);
      }
    } catch (error) {
      this.logger.error(`项目资源回收调度失败: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
