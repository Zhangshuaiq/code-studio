import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface GenerationAdmission {
  admitted: boolean;
  reason?: 'team_limit' | 'user_limit';
  active?: number;
  limit?: number;
}

/** PostgreSQL advisory lock 保证多个 Worker 对同一团队/用户的并发判定是原子的。 */
@Injectable()
export class GenerationSchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async admit(taskId: string): Promise<GenerationAdmission> {
    const teamLimit = Number(this.config.get('GENERATION_MAX_PER_TEAM', 4));
    const userLimit = Number(this.config.get('GENERATION_MAX_PER_USER', 2));
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({
        where: { id: taskId },
        select: {
          status: true,
          session: {
            select: {
              userId: true,
              projectId: true,
              project: { select: { teamId: true } },
            },
          },
        },
      });
      if (!task || ['cancelled', 'cancelling', 'succeeded'].includes(task.status)) {
        return { admitted: false, reason: 'user_limit', active: 0, limit: 0 };
      }
      const teamId = task.session.project.teamId;
      const scopeKey = teamId ?? `personal:${task.session.projectId}`;
      // 所有调用固定先团队、后用户加锁，避免跨 Worker 的竞态和死锁。
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${'generation:team:' + scopeKey}))`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${'generation:user:' + task.session.userId}))`;
      const activeStatus = ['running', 'cancelling'];
      const [teamActive, userActive] = await Promise.all([
        tx.task.count({
          where: {
            id: { not: taskId },
            status: { in: activeStatus },
            session: teamId
              ? { project: { teamId } }
              : { projectId: task.session.projectId },
          },
        }),
        tx.task.count({
          where: {
            id: { not: taskId },
            status: { in: activeStatus },
            session: { userId: task.session.userId },
          },
        }),
      ]);
      if (teamLimit > 0 && teamActive >= teamLimit) {
        await this.wait(tx, taskId, `等待团队生成资源（${teamActive}/${teamLimit}）`);
        return { admitted: false, reason: 'team_limit', active: teamActive, limit: teamLimit };
      }
      if (userLimit > 0 && userActive >= userLimit) {
        await this.wait(tx, taskId, `等待用户生成资源（${userActive}/${userLimit}）`);
        return { admitted: false, reason: 'user_limit', active: userActive, limit: userLimit };
      }
      await tx.task.update({
        where: { id: taskId },
        data: { status: 'running', startedAt: new Date(), finishedAt: null, failureCode: null },
      });
      return { admitted: true };
    });
  }

  private wait(tx: Prisma.TransactionClient, taskId: string, message: string) {
    return tx.task.update({
      where: { id: taskId },
      data: { status: 'queued', resultLog: message, resourceWaitCount: { increment: 1 } },
    });
  }
}
