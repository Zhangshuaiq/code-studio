import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectService } from './project.service';

/** 数据库持久化的 Git 导入调度器；只由 Worker 进程装载。 */
@Injectable()
export class ProjectImportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectImportWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly leaseMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectService,
    config: ConfigService,
  ) {
    this.leaseMs = Number(config.get('PROJECT_IMPORT_LEASE_MS', 30 * 60_000));
  }

  onModuleInit() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 3_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.prisma.project.updateMany({
        where: {
          status: 'importing',
          OR: [
            { importLeaseUntil: { lte: new Date() } },
            { importLeaseUntil: null },
          ],
        },
        data: { status: 'import_queued', importLeaseUntil: null, importError: '上一次导入 Worker 中断，已重新排队' },
      });
      const candidate = await this.prisma.project.findFirst({
        where: { status: 'import_queued' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!candidate) return;
      const claimed = await this.prisma.project.updateMany({
        where: { id: candidate.id, status: 'import_queued' },
        data: {
          status: 'importing',
          importStartedAt: new Date(),
          importFinishedAt: null,
          importLeaseUntil: new Date(Date.now() + this.leaseMs),
          importError: null,
          importAttempts: { increment: 1 },
        },
      });
      if (!claimed.count) return;
      const heartbeat = setInterval(() => {
        void this.renewLease(candidate.id);
      }, Math.max(30_000, Math.floor(this.leaseMs / 3)));
      heartbeat.unref();
      try {
        await this.projects.executeImport(candidate.id);
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      this.logger.error(`Git 项目导入调度失败: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async renewLease(projectId: string) {
    try {
      await this.prisma.project.updateMany({
        where: { id: projectId, status: 'importing' },
        data: { importLeaseUntil: new Date(Date.now() + this.leaseMs) },
      });
    } catch (error) {
      this.logger.warn(`Git 项目导入租约续期失败: ${(error as Error).message}`);
    }
  }
}
