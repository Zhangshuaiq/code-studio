import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentQueueService } from '../agent/agent-queue.service';
import { GenerationExecutorService } from '../agent/generation-executor.service';
import { BusinessLogService } from '../business-log/business-log.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import { ConfigService } from '@nestjs/config';
import { quotaPercent } from '../monitoring/monitoring-calculations';
import { TracingService } from '../tracing/tracing.service';
import { ResourceMetricsService } from '../resource-metrics/resource-metrics.service';

@Injectable()
export class PlatformHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AgentQueueService,
    private readonly generationExecutor: GenerationExecutorService,
    private readonly logs: BusinessLogService,
    private readonly access: ProjectAccessService,
    private readonly config: ConfigService,
    private readonly tracing: TracingService,
    private readonly resourceMetrics: ResourceMetricsService,
  ) {}

  async overview() {
    const checkedAt = new Date().toISOString();
    const databaseStarted = Date.now();
    const database = await this.prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`
      .then(() => ({ available: true, latencyMs: Date.now() - databaseStarted }))
      .catch((error: Error) => ({ available: false, latencyMs: Date.now() - databaseStarted, error: error.message }));
    const [redis, generationExecutor, openSearch, tempo, prometheus] = await Promise.all([
      this.queue.health(),
      this.generationExecutor.health(),
      this.logs.getHealth(),
      this.tracing.health(),
      this.resourceMetrics.health(),
    ]);
    const dependencies = { database, redis, generationExecutor, openSearch, tempo, prometheus };
    const values = Object.values(dependencies);
    const healthy = values.filter((item) => item.available).length;
    const [failedProjectCleanups, unacknowledgedProjectCleanups] = database.available
      ? await this.prisma.$transaction([
          this.prisma.project.count({ where: { status: 'deletion_failed' } }),
          this.prisma.project.count({ where: { status: 'deletion_failed', deletionAcknowledgedAt: null } }),
        ]).catch(() => [-1, -1])
      : [-1, -1];
    const operationalIssues = [
      unacknowledgedProjectCleanups > 0
        ? { code: 'PROJECT_CLEANUP_FAILED', severity: 'warning', count: unacknowledgedProjectCleanups, message: `${unacknowledgedProjectCleanups} 个项目资源回收失败尚未确认` }
        : null,
    ].filter(Boolean);
    return {
      status: healthy === values.length ? 'healthy' : healthy ? 'degraded' : 'unavailable',
      checkedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      build: {
        version: this.config.get<string>('APP_VERSION', 'development'),
        gitSha: this.config.get<string>('BUILD_GIT_SHA', 'unknown'),
        builtAt: this.config.get<string>('BUILD_TIME', 'unknown'),
        image: this.config.get<string>('BUILD_IMAGE', 'unknown'),
      },
      dependencies,
      operationalIssues,
      operations: { projectCleanups: { failed: failedProjectCleanups, unacknowledged: unacknowledgedProjectCleanups } },
    };
  }

  async projectUsage(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, 'read');
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const [tasks24h, activeTasks, sandboxes, previews, deployment] = await Promise.all([
      this.prisma.task.count({ where: { session: { projectId }, createdAt: { gte: since } } }),
      this.prisma.task.count({ where: { session: { projectId }, status: { in: ['queued', 'running', 'cancelling'] } } }),
      this.prisma.sandboxInstance.groupBy({ by: ['status'], where: { session: { projectId } }, _count: { _all: true } }),
      this.prisma.previewInstance.groupBy({ by: ['status'], where: { session: { projectId } }, _count: { _all: true } }),
      this.prisma.deployment.findUnique({ where: { projectId }, select: { status: true, image: true, updatedAt: true } }),
    ]);
    const statuses = (rows: Array<{ status: string; _count: { _all: number } }>) =>
      Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
    const sandboxStatuses = statuses(sandboxes);
    const previewStatuses = statuses(previews);
    const dailyLimit = Math.max(1, Number(this.config.get('PROJECT_DAILY_GENERATION_LIMIT', 100)));
    const previewLimit = Math.max(1, Number(this.config.get('PREVIEW_MAX_PER_PROJECT', 10)));
    return {
      period: { from: since.toISOString(), to: new Date().toISOString() },
      generation: { used: tasks24h, limit: dailyLimit, percent: quotaPercent(tasks24h, dailyLimit), active: activeTasks },
      previews: { used: (previewStatuses.ready ?? 0) + (previewStatuses.starting ?? 0), limit: previewLimit, statuses: previewStatuses },
      sandboxes: {
        running: sandboxStatuses.running ?? 0,
        statuses: sandboxStatuses,
        perInstanceCpu: Number(this.config.get('SANDBOX_CPUS', 1)),
        perInstanceMemoryMb: Number(this.config.get('SANDBOX_MEMORY_MB', 1024)),
      },
      deployment,
    };
  }
}
