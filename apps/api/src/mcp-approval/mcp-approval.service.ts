import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { pageArgs, pageResult } from '../common/dto/page-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import { McpApprovalQueryDto } from './dto/mcp-approval-query.dto';
import type { AuthUser } from '../auth/jwt.strategy';
import { PERMISSIONS } from '../auth/permissions';

export type McpToolRisk = 'W1' | 'X2' | 'D3';

export interface RequestMcpApprovalInput {
  requesterId: string;
  requesterName: string;
  clientId: string;
  agentRunId?: string;
  toolName: string;
  riskLevel: McpToolRisk;
  requiredPermissions: string[];
  reviewerIds: string[];
  environment?: string;
  resourceType?: string;
  resourceId?: string;
  resourceVersion?: string;
  arguments: unknown;
  argumentsSummary: Record<string, unknown>;
  impactSummary: string;
  ttlSeconds?: number;
}

@Injectable()
export class McpApprovalService {
  constructor(private readonly prisma: PrismaService) {}

  async request(input: RequestMcpApprovalInput) {
    const argumentsHash = hashArguments(input.arguments);
    const requestedReviewerIds = [...new Set(input.reviewerIds.filter((id) => UUID_RE.test(id)))].sort();
    const requiredPermissions = [...new Set(input.requiredPermissions)].sort();
    const reviewers = await this.prisma.user.findMany({
      where: { id: { in: requestedReviewerIds }, status: 'active' },
      select: { id: true, roles: { select: { permissions: true } } },
    });
    const reviewerIds = reviewers.filter((reviewer) => {
      const permissions = new Set(reviewer.roles.flatMap((role) => role.permissions));
      return permissions.has(PERMISSIONS.MCP_APPROVAL_REVIEW) && requiredPermissions.every((permission) => permissions.has(permission));
    }).map((reviewer) => reviewer.id).sort();
    if (!reviewerIds.length) throw new BadRequestException({ code: 'MCP_APPROVAL_REVIEWER_REQUIRED', message: '没有可处理该操作且权限有效的审批人' });
    const now = new Date();
    const existing = await this.prisma.mcpToolApproval.findFirst({
      where: {
        requesterId: input.requesterId,
        clientId: input.clientId,
        toolName: input.toolName,
        argumentsHash,
        riskLevel: input.riskLevel,
        requiredPermissions: { equals: requiredPermissions },
        reviewerIds: { equals: reviewerIds },
        environment: input.environment ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        resourceVersion: input.resourceVersion ?? null,
        status: { in: ['requested', 'approved'] },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return approvalView(existing);
    const ttlSeconds = Math.min(86_400, Math.max(60, input.ttlSeconds ?? 1_800));
    const approval = await this.prisma.mcpToolApproval.create({
      data: {
        requesterId: input.requesterId,
        requesterName: input.requesterName.slice(0, 200),
        clientId: input.clientId.slice(0, 200),
        agentRunId: input.agentRunId?.slice(0, 100),
        toolName: input.toolName.slice(0, 200),
        riskLevel: input.riskLevel,
        requiredPermissions,
        reviewerIds,
        environment: input.environment?.slice(0, 80),
        resourceType: input.resourceType?.slice(0, 100),
        resourceId: input.resourceId?.slice(0, 200),
        resourceVersion: input.resourceVersion?.slice(0, 200),
        argumentsHash,
        argumentsSummary: sanitizeSummary(input.argumentsSummary) as Prisma.InputJsonObject,
        impactSummary: input.impactSummary.trim().slice(0, 2_000),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
      },
    });
    return approvalView(approval);
  }

  async listMine(userId: string, query: McpApprovalQueryDto) {
    const now = new Date();
    const statusWhere: Prisma.McpToolApprovalWhereInput = query.status === 'expired'
      ? { OR: [{ status: 'expired' }, { status: { in: ['requested', 'approved'] }, expiresAt: { lte: now } }] }
      : query.status === 'requested' || query.status === 'approved'
        ? { status: query.status, expiresAt: { gt: now } }
        : query.status ? { status: query.status } : {};
    const where: Prisma.McpToolApprovalWhereInput = { requesterId: userId, ...statusWhere };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.mcpToolApproval.findMany({ where, ...pageArgs(query), orderBy: { createdAt: 'desc' } }),
      this.prisma.mcpToolApproval.count({ where }),
    ]);
    return pageResult(items.map(approvalView), total, query);
  }

  async getMine(userId: string, id: string) {
    const approval = await this.prisma.mcpToolApproval.findFirst({ where: { id, requesterId: userId } });
    if (!approval) throw new NotFoundException({ code: 'MCP_APPROVAL_NOT_FOUND', message: '审批单不存在或无权访问' });
    return approvalView(approval);
  }

  async approve(reviewer: AuthUser, id: string, reason?: string) {
    const approval = await this.getReviewable(reviewer, id);
    if (approval.riskLevel === 'D3' && approval.requesterId === reviewer.id) {
      throw new ForbiddenException({ code: 'MCP_APPROVAL_SELF_REVIEW_FORBIDDEN', message: 'D3 高风险操作禁止申请人自审' });
    }
    if (approval.riskLevel === 'D3' && !cleanReason(reason)) throw new BadRequestException({ code: 'MCP_APPROVAL_REASON_REQUIRED', message: 'D3 高风险操作批准时必须填写理由' });
    const now = new Date();
    const changed = await this.prisma.mcpToolApproval.updateMany({
      where: { id, status: 'requested', expiresAt: { gt: now } },
      data: { status: 'approved', reviewerId: reviewer.id, reviewerName: reviewer.username, decisionReason: cleanReason(reason), reviewedAt: now },
    });
    if (!changed.count) throw new ConflictException({ code: 'MCP_APPROVAL_STATE_CONFLICT', message: '审批单已处理或已过期' });
    return this.getMine(approval.requesterId, id);
  }

  async getForReview(reviewer: AuthUser, id: string) {
    return approvalView(await this.getReviewable(reviewer, id));
  }

  async listForReview(reviewer: AuthUser, query: McpApprovalQueryDto) {
    const now = new Date();
    const candidates = await this.prisma.mcpToolApproval.findMany({
      where: { reviewerIds: { has: reviewer.id }, status: 'requested', expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
      take: 1_000,
    });
    const eligible = candidates.filter((approval) => approval.requiredPermissions.every((permission) => reviewer.permissions.includes(permission)));
    const start = (query.page - 1) * query.pageSize;
    return {
      ...pageResult(eligible.slice(start, start + query.pageSize).map(approvalView), eligible.length, query),
      truncated: candidates.length === 1_000,
    };
  }

  async reject(reviewer: AuthUser, id: string, reason: string) {
    const approval = await this.getReviewable(reviewer, id);
    if (!cleanReason(reason)) throw new BadRequestException({ code: 'MCP_APPROVAL_REASON_REQUIRED', message: '拒绝审批时必须填写理由' });
    const now = new Date();
    const changed = await this.prisma.mcpToolApproval.updateMany({
      where: { id, status: 'requested', expiresAt: { gt: now } },
      data: { status: 'rejected', reviewerId: reviewer.id, reviewerName: reviewer.username, decisionReason: cleanReason(reason), reviewedAt: now },
    });
    if (!changed.count) throw new ConflictException({ code: 'MCP_APPROVAL_STATE_CONFLICT', message: '审批单已处理或已过期' });
    return this.getMine(approval.requesterId, id);
  }

  async cancel(requesterId: string, id: string) {
    const changed = await this.prisma.mcpToolApproval.updateMany({
      where: { id, requesterId, status: { in: ['requested', 'approved'] }, expiresAt: { gt: new Date() } },
      data: { status: 'cancelled' },
    });
    if (!changed.count) throw new ConflictException({ code: 'MCP_APPROVAL_STATE_CONFLICT', message: '审批单不存在、无权取消或已进入执行阶段' });
    return this.getMine(requesterId, id);
  }

  async consume(input: { approvalId: string; requesterId: string; clientId: string; toolName: string; arguments: unknown; resourceVersion?: string }) {
    const changed = await this.prisma.mcpToolApproval.updateMany({
      where: {
        id: input.approvalId,
        requesterId: input.requesterId,
        clientId: input.clientId,
        toolName: input.toolName,
        argumentsHash: hashArguments(input.arguments),
        resourceVersion: input.resourceVersion ?? null,
        status: 'approved',
        expiresAt: { gt: new Date() },
      },
      data: { status: 'consuming' },
    });
    if (!changed.count) throw new ConflictException({ code: 'MCP_APPROVAL_INVALID', message: '审批不存在、已过期、已消费或与当前调用不匹配' });
    return { approvalId: input.approvalId, status: 'consuming' as const };
  }

  async completeConsumption(approvalId: string, succeeded: boolean) {
    const changed = await this.prisma.mcpToolApproval.updateMany({
      where: { id: approvalId, status: 'consuming' },
      data: { status: succeeded ? 'consumed' : 'execution_failed', consumedAt: new Date() },
    });
    if (!changed.count) throw new ConflictException({ code: 'MCP_APPROVAL_CONSUMPTION_CONFLICT', message: '审批单不在消费状态' });
  }

  private async getReviewable(reviewer: AuthUser, id: string) {
    const approval = await this.prisma.mcpToolApproval.findUnique({ where: { id } });
    if (!approval) throw new NotFoundException({ code: 'MCP_APPROVAL_NOT_FOUND', message: '审批单不存在' });
    if (!approval.reviewerIds.includes(reviewer.id)) throw new NotFoundException({ code: 'MCP_APPROVAL_NOT_FOUND', message: '审批单不存在或未分配给当前用户' });
    const missing = approval.requiredPermissions.filter((permission) => !reviewer.permissions.includes(permission));
    if (missing.length) throw new ForbiddenException({ code: 'MCP_APPROVAL_REVIEW_SCOPE_DENIED', message: '审批人不具备目标操作所需权限', missingPermissions: missing });
    return approval;
  }
}

function hashArguments(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function sanitizeSummary(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key.slice(0, 100), SECRET_KEY_RE.test(key) ? '[redacted]' : summaryValue(item, 0)]));
}

function summaryValue(value: unknown, depth: number): unknown {
  if (depth >= 3) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => summaryValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([key, item]) => [key.slice(0, 100), SECRET_KEY_RE.test(key) ? '[redacted]' : summaryValue(item, depth + 1)]));
  return String(value).slice(0, 500);
}

const SECRET_KEY_RE = /pass(word)?|passphrase|token|private.?key|api.?key|secret|authorization|cookie|credential|kubeconfig/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanReason(value?: string) { return value?.trim().slice(0, 2_000) || null; }

function approvalView<T extends { status: string; expiresAt: Date; argumentsHash: string }>(approval: T) {
  const { reviewerIds: _reviewerIds, ...visible } = approval as T & { reviewerIds?: string[] };
  return {
    ...visible,
    argumentsHash: approval.argumentsHash,
    effectiveStatus: ['requested', 'approved'].includes(approval.status) && approval.expiresAt <= new Date() ? 'expired' : approval.status,
  };
}
