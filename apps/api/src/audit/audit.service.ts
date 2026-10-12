import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorId?: string | null;
  actorName?: string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceName?: string | null;
  result?: string;
  ip?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  detail?: unknown;
}

export interface AuditQuery {
  q?: string;
  actor?: string;
  action?: string;
  resourceType?: string;
  result?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/** The same row shape is used for best-effort and transactional audit writes. */
export function auditRecordData(e: AuditEntry): Prisma.AuditLogCreateInput {
  const detail = e.detail === undefined ? undefined : (e.detail as Prisma.InputJsonValue);
  return {
    actorId: e.actorId ?? null, actorName: e.actorName || 'system', action: e.action,
    resourceType: e.resourceType ?? null, resourceId: e.resourceId ?? null,
    resourceName: e.resourceName ?? null, result: e.result || 'success',
    ip: e.ip ?? null, method: e.method ?? null, path: e.path ?? null,
    statusCode: e.statusCode ?? null, detail,
    searchText: [e.actorName, e.action, e.resourceType, e.resourceId, e.resourceName, e.path,
      detail !== undefined ? JSON.stringify(detail) : ''].filter(Boolean).join(' '),
  };
}

export type AuditActorContext = Pick<AuditEntry, 'actorId' | 'actorName' | 'ip' | 'method' | 'path'>;
/** Call only with the server-authenticated request, never with a request body. */
export function auditActorContext(req: { user?: { id: string; username?: string }; ip?: string; socket?: { remoteAddress?: string }; method?: string; originalUrl?: string; url?: string }): AuditActorContext {
  return { actorId: req.user?.id ?? null, actorName: req.user?.username || 'anonymous',
    ip: req.ip || req.socket?.remoteAddress || null, method: req.method,
    path: String(req.originalUrl || req.url || '').split('?')[0] };
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** 落一条审计（fire-and-forget，绝不因审计失败影响主流程） */
  record(e: AuditEntry): void {
    this.write(e).catch((err) =>
      this.logger.warn(`审计写入失败: ${String(err)}`),
    );
  }

  private async write(e: AuditEntry) {
    await this.prisma.auditLog.create({ data: auditRecordData(e) });
  }

  async search(p: AuditQuery) {
    const page = Math.max(1, Number(p.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 20));
    const where: Prisma.AuditLogWhereInput = {};
    if (p.q) where.searchText = { contains: p.q, mode: 'insensitive' };
    if (p.actor)
      where.OR = [
        { actorName: { contains: p.actor, mode: 'insensitive' } },
        { actorId: p.actor },
      ];
    if (p.action) where.action = p.action;
    if (p.resourceType) where.resourceType = p.resourceType;
    if (p.result) where.result = p.result;
    if (p.from || p.to)
      where.createdAt = {
        ...(p.from ? { gte: new Date(p.from) } : {}),
        ...(p.to ? { lte: new Date(p.to) } : {}),
      };

    // List and count must observe the same snapshot during concurrent ingestion.
    const [items, total] = await this.prisma.$transaction(async (tx) => Promise.all([
      tx.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      tx.auditLog.count({ where }),
    ]), { isolationLevel: 'RepeatableRead' });
    return { items, total, page, pageSize };
  }

  /** 过滤下拉用：现有的动作 / 资源类型去重 */
  async facets() {
    const [actions, types] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
      }),
      this.prisma.auditLog.findMany({
        distinct: ['resourceType'],
        select: { resourceType: true },
      }),
    ], { isolationLevel: 'RepeatableRead' });
    return {
      actions: actions.map((a) => a.action),
      resourceTypes: types.map((t) => t.resourceType).filter(Boolean),
    };
  }
}
