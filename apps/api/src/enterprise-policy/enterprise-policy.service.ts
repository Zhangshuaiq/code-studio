import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { PrismaService } from '../prisma/prisma.service';
import { AddOrganizationMemberDto, CreateOrganizationDto, CreateOrganizationInvitationDto, OrganizationAuditQueryDto, UpdateEnterprisePolicyDto } from './dto/enterprise-policy.dto';
import { signEnterprisePolicy } from './enterprise-policy-token';
import type { AuthUser } from '../auth/jwt.strategy';
import type { Prisma } from '@prisma/client';
import { auditRecordData, type AuditActorContext } from '../audit/audit.service';

const DEFAULT_POLICY = { terminalEnabled: true, allowedModelEngines: ['codex-cli', 'claude-code', 'aider', 'openai-compatible', 'ollama'], allowedConnectorTypes: ['postgres', 'mysql', 'kafka', 'kubernetes'], allowedGitHosts: ['local'], allowedNetworkHosts: [], minimumClientVersion: '0.1.0', offlineDays: 7 };
function memberAuditSnapshot(member: { id: string; organizationId: string; userId: string; role: string; status: string } | null) {
  return member ? { id: member.id, organizationId: member.organizationId, userId: member.userId, role: member.role, status: member.status } : null;
}

@Injectable()
export class EnterprisePolicyService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}
  organizations() { return this.prisma.organization.findMany({ include: { _count: { select: { members: true } }, policy: true }, orderBy: { createdAt: 'desc' }, take: 1000 }); }
  async createOrganization(input: CreateOrganizationDto, auditActor?: AuditActorContext) {
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({ data: { name: input.name.trim(), slug: input.slug.toLowerCase(), seatLimit: input.seatLimit ?? 10, policy: { create: DEFAULT_POLICY } }, include: { policy: true } });
      await tx.auditLog.create({ data: auditRecordData({ ...auditActor, action: 'organization.create', resourceType: 'organization', resourceId: organization.id, resourceName: organization.name, statusCode: 201,
        detail: { transactional: true, before: null, after: { id: organization.id, name: organization.name, slug: organization.slug, seatLimit: organization.seatLimit,
          verifiedDomains: [...organization.verifiedDomains], policy: policyAuditSnapshot(organization.policy) } } }) });
      return organization;
    });
  }
  async members(organizationId: string) { await this.requireOrganization(organizationId); return this.prisma.organizationMember.findMany({ where: { organizationId }, include: { user: { select: { id: true, username: true, email: true, displayName: true } } }, orderBy: { createdAt: 'asc' }, take: 10000 }); }
  async addMember(organizationId: string, input: AddOrganizationMemberDto, auditActor?: AuditActorContext) {
    if (input.role && !['owner', 'admin', 'auditor', 'member'].includes(input.role)) throw new BadRequestException('组织角色无效');
    return this.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } }); const existing = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: input.userId } } });
    await this.protectLastOwner(tx, organizationId, existing, input.role ?? existing?.role ?? 'member');
    if (existing?.status !== 'active' && await tx.organizationMember.count({ where: { organizationId, status: 'active' } }) >= organization.seatLimit) throw new ForbiddenException({ code: 'ORGANIZATION_SEAT_LIMIT', message: `组织席位上限为 ${organization.seatLimit}` });
    const before = memberAuditSnapshot(existing);
    const result = await tx.organizationMember.upsert({ where: { organizationId_userId: { organizationId, userId: input.userId } }, create: { organizationId, userId: input.userId, role: input.role ?? 'member' }, update: { role: input.role ?? existing?.role ?? 'member', status: 'active' } });
    await this.auditMemberChange(tx, organizationId, input.userId, 'organization.member.add', before, memberAuditSnapshot(result), auditActor, 201);
    return result;
    });
  }
  async removeMember(organizationId: string, userId: string, actorId?: string, auditActor?: AuditActorContext) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
      const actor = actorId ? await this.requireManager(tx, organizationId, actorId) : null;
      const member = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
      if (!member) throw new NotFoundException({ code: 'ORGANIZATION_MEMBER_NOT_FOUND', message: '组织成员不存在' });
      if (actor?.role === 'admin' && member.role !== 'member') throw new ForbiddenException({ code: 'ORGANIZATION_ROLE_FORBIDDEN', message: '仅所有者可以管理管理员或所有者' });
      await this.protectLastOwner(tx, organizationId, member, null);
      const before = memberAuditSnapshot(member);
      await tx.organizationMember.delete({ where: { id: member.id } });
      await this.auditMemberChange(tx, organizationId, userId, 'organization.member.remove', before, null, auditActor || { actorId });
      return { success: true };
    });
  }
  async myOrganizations(userId: string) {
    return this.prisma.organizationMember.findMany({ where: { userId, status: 'active' }, select: { userId: true, role: true, organization: { select: { id: true, name: true, slug: true, seatLimit: true } } }, orderBy: { createdAt: 'asc' }, take: 1000 });
  }
  async managedMembers(organizationId: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.requireManager(tx, organizationId, actorId);
      return tx.organizationMember.findMany({ where: { organizationId }, include: { user: { select: { id: true, username: true, email: true, displayName: true } } }, orderBy: { createdAt: 'asc' }, take: 10000 });
    });
  }
  async organizationAudit(organizationId: string, actorId: string, input: OrganizationAuditQueryDto = {}) {
    const page = input.page ?? 1; const pageSize = input.pageSize ?? 20;
    if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BadRequestException('审计分页参数无效');
    const from = input.from ? new Date(input.from) : undefined; const to = input.to ? new Date(input.to) : undefined;
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from > to)) throw new BadRequestException('审计时间范围无效');
    if (input.action && !/^organization\.[a-z.]+$/.test(input.action)) throw new BadRequestException('组织审计动作无效');
    if (input.result && !['success', 'failure'].includes(input.result)) throw new BadRequestException('组织审计结果无效');
    return this.prisma.$transaction(async (tx) => {
      await this.requireAuditReader(tx, organizationId, actorId);
      // No client-supplied tenant/resource filter can replace these constraints.
      const where: Prisma.AuditLogWhereInput = { resourceType: 'organization', resourceId: organizationId, action: input.action || { startsWith: 'organization.' } };
      if (input.q) where.searchText = { contains: input.q, mode: 'insensitive' };
      if (input.actor) where.OR = [{ actorName: { contains: input.actor, mode: 'insensitive' } }, { actorId: input.actor }];
      if (input.result) where.result = input.result;
      if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      const [items, total] = await Promise.all([
        tx.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize, select: { id: true, createdAt: true, actorId: true, actorName: true, action: true, resourceId: true, result: true, statusCode: true, detail: true } }),
        tx.auditLog.count({ where }),
      ]);
      return { items, total, page, pageSize };
    }, { isolationLevel: 'RepeatableRead' });
  }
  async updateMemberRole(organizationId: string, userId: string, role: string, actorId?: string, auditActor?: AuditActorContext) {
    if (!['owner', 'admin', 'auditor', 'member'].includes(role)) throw new BadRequestException('组织角色无效');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
      const actor = actorId ? await this.requireManager(tx, organizationId, actorId) : null;
      const member = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
      if (!member) throw new NotFoundException({ code: 'ORGANIZATION_MEMBER_NOT_FOUND', message: '组织成员不存在' });
      // Admins may manage ordinary membership, but never grant roles or change
      // another manager. Platform admin calls still preserve the owner invariant.
      if (actor?.role === 'admin' && (member.role !== 'member' || role !== 'member')) throw new ForbiddenException({ code: 'ORGANIZATION_ROLE_FORBIDDEN', message: '仅所有者可以分配或修改管理角色' });
      await this.protectLastOwner(tx, organizationId, member, role);
      const before = memberAuditSnapshot(member);
      const result = await tx.organizationMember.update({ where: { id: member.id }, data: { role } });
      await this.auditMemberChange(tx, organizationId, userId, 'organization.member.role.update', before, memberAuditSnapshot(result), auditActor || { actorId });
      return result;
    });
  }
  private async auditMemberChange(tx: Prisma.TransactionClient, organizationId: string, userId: string, action: string, before: ReturnType<typeof memberAuditSnapshot>, after: ReturnType<typeof memberAuditSnapshot>, actor?: AuditActorContext, statusCode = 200) {
    // No catch: failure to persist evidence must roll back the permission change.
    await tx.auditLog.create({ data: auditRecordData({ ...actor, action, resourceType: 'organization', resourceId: organizationId,
      result: 'success', statusCode, detail: { targets: { userId }, before, after, transactional: true } }) });
  }
  private async requireManager(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
    const actor = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
    if (!actor || actor.status !== 'active' || !['owner', 'admin'].includes(actor.role)) throw new ForbiddenException({ code: 'ORGANIZATION_MANAGEMENT_FORBIDDEN', message: '没有该组织的管理权限' });
    return actor;
  }
  private async requireAuditReader(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
    const actor = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
    if (!actor || actor.status !== 'active' || !['owner', 'admin', 'auditor'].includes(actor.role))
      throw new ForbiddenException({ code: 'ORGANIZATION_AUDIT_FORBIDDEN', message: '没有该组织的审计查看权限' });
    return actor;
  }
  private async protectLastOwner(tx: Prisma.TransactionClient, organizationId: string, member: { role: string; status: string } | null, nextRole: string | null) {
    if (member?.role === 'owner' && member.status === 'active' && nextRole !== 'owner' && await tx.organizationMember.count({ where: { organizationId, role: 'owner', status: 'active' } }) <= 1) throw new ForbiddenException({ code: 'ORGANIZATION_LAST_OWNER', message: '请先指定另一名所有者，不能移除或降级最后一名所有者' });
  }
  async invitations(organizationId: string, actorId?: string) {
    return this.prisma.$transaction(async (tx) => {
      if (actorId) await this.requireManager(tx, organizationId, actorId);
      else await this.requireOrganization(organizationId);
      const rows = await tx.organizationInvitation.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 1000 });
      return rows.map(publicInvitation);
    });
  }
  async domains(organizationId: string, actorId?: string) {
    return this.prisma.$transaction(async (tx) => {
      if (actorId) await this.requireManager(tx, organizationId, actorId);
      else await this.requireOrganization(organizationId);
      return (await tx.organizationDomain.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 100 })).map(domainInstructions);
    });
  }
  async createDomain(organizationId: string, value: string, actorId?: string, auditActor?: AuditActorContext) {
    const domain = normalizeDomain(value);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`domain:${domain}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
      if (actorId) await this.requireManager(tx, organizationId, actorId);
      const organization = await tx.organization.findUnique({ where: { id: organizationId } });
      if (!organization) throw new NotFoundException({ code: 'ORGANIZATION_NOT_FOUND', message: '组织不存在' });
      const existing = await tx.organizationDomain.findUnique({ where: { organizationId_domain: { organizationId, domain } } });
      const before = existing ? domainAuditSnapshot(existing) : null;
      if (existing?.verifiedAt) {
        await this.auditDomainChange(tx, organizationId, 'organization.domain.create', before, before, organization.verifiedDomains, organization.verifiedDomains, auditActor || { actorId });
        return domainInstructions(existing);
      }
      if (await tx.organizationDomain.findFirst({ where: { domain, verifiedAt: { not: null }, organizationId: { not: organizationId } } })) throw new ForbiddenException({ code: 'ORGANIZATION_DOMAIN_CLAIMED', message: '该域名已由其他组织验证' });
      if (!existing && await tx.organizationDomain.count({ where: { organizationId } }) >= 100) throw new BadRequestException('每个组织最多配置 100 个域名');
      const challenge = { token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 7 * 86400_000) };
      const result = await tx.organizationDomain.upsert({ where: { organizationId_domain: { organizationId, domain } }, create: { organizationId, domain, ...challenge }, update: challenge });
      await this.auditDomainChange(tx, organizationId, 'organization.domain.create', before, domainAuditSnapshot(result), organization.verifiedDomains, organization.verifiedDomains, auditActor || { actorId });
      return domainInstructions(result);
    });
  }
  async verifyDomain(organizationId: string, id: string, actorId?: string, auditActor?: AuditActorContext) {
    const challenge = await this.prisma.$transaction(async (tx) => {
      if (actorId) await this.requireManager(tx, organizationId, actorId);
      return tx.organizationDomain.findFirst({ where: { id, organizationId } });
    });
    if (!challenge) throw new NotFoundException('域名验证申请不存在');
    if (!challenge.verifiedAt) {
      if (challenge.expiresAt <= new Date()) throw new BadRequestException({ code: 'ORGANIZATION_DOMAIN_EXPIRED', message: '验证申请已过期，请重新生成记录' });
      let records: string[][];
      try { records = await this.resolveDomainTxt(`_code-studio-verification.${challenge.domain}`); }
      catch { throw new BadRequestException({ code: 'ORGANIZATION_DOMAIN_DNS_UNAVAILABLE', message: '未读取到 DNS TXT 记录，请检查记录并等待 DNS 生效' }); }
      if (!records.some((parts) => parts.join('') === `code-studio-verification=${challenge.token}`)) throw new BadRequestException({ code: 'ORGANIZATION_DOMAIN_TOKEN_MISMATCH', message: 'DNS TXT 记录与当前验证值不一致' });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`domain:${challenge.domain}`}))`;
      // Keep the same domain -> organization lock order for all domain writes.
      // DNS runs outside the transaction; recheck the current role afterwards.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
      if (actorId) await this.requireManager(tx, organizationId, actorId);
      const current = await tx.organizationDomain.findFirst({ where: { id, organizationId } });
      if (!current || current.domain !== challenge.domain) throw new BadRequestException('验证申请已更新，请重试');
      const before = domainAuditSnapshot(current);
      const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
      const verifiedBefore = [...organization.verifiedDomains];
      if (current.verifiedAt) {
        await this.auditDomainChange(tx, organizationId, 'organization.domain.verify', before, before, organization.verifiedDomains, organization.verifiedDomains, auditActor || { actorId });
        return domainInstructions(current);
      }
      if (challenge.verifiedAt) throw new BadRequestException('验证申请已更新，请重试');
      if (await tx.organizationDomain.findFirst({ where: { domain: challenge.domain, verifiedAt: { not: null }, organizationId: { not: organizationId } } })) throw new ForbiddenException({ code: 'ORGANIZATION_DOMAIN_CLAIMED', message: '该域名已由其他组织验证' });
      const claimed = await tx.organizationDomain.updateMany({ where: { id, organizationId, token: challenge.token, expiresAt: { gt: new Date() }, verifiedAt: null }, data: { verifiedAt: new Date() } });
      if (!claimed.count) throw new BadRequestException('验证申请已更新，请重试');
      const verifiedDomains = [...new Set([...verifiedBefore, challenge.domain])];
      await tx.organization.update({ where: { id: organizationId }, data: { verifiedDomains } });
      const result = await tx.organizationDomain.findUniqueOrThrow({ where: { id } });
      await this.auditDomainChange(tx, organizationId, 'organization.domain.verify', before, domainAuditSnapshot(result), verifiedBefore, verifiedDomains, auditActor || { actorId });
      return domainInstructions(result);
    });
  }
  async removeDomain(organizationId: string, id: string, actorId?: string, auditActor?: AuditActorContext) {
    return this.prisma.$transaction(async (tx) => {
      if (actorId) await this.requireManager(tx, organizationId, actorId);
      const domain = await tx.organizationDomain.findFirst({ where: { id, organizationId } });
      if (!domain) throw new NotFoundException('域名配置不存在');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`domain:${domain.domain}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
      if (actorId) await this.requireManager(tx, organizationId, actorId);
      const current = await tx.organizationDomain.findFirst({ where: { id, organizationId } });
      if (!current || current.domain !== domain.domain) throw new NotFoundException('域名配置不存在');
      const before = domainAuditSnapshot(current);
      const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
      const verifiedBefore = [...organization.verifiedDomains];
      const verifiedDomains = verifiedBefore.filter((value) => value !== current.domain);
      const removed = await tx.organizationDomain.deleteMany({ where: { id, organizationId } });
      if (!removed.count) throw new NotFoundException('域名配置不存在');
      await tx.organization.update({ where: { id: organizationId }, data: { verifiedDomains } });
      await this.auditDomainChange(tx, organizationId, 'organization.domain.remove', before, null, verifiedBefore, verifiedDomains, auditActor || { actorId });
      return { success: true };
    });
  }
  private async auditDomainChange(tx: Prisma.TransactionClient, organizationId: string, action: string, before: ReturnType<typeof domainAuditSnapshot> | null, after: ReturnType<typeof domainAuditSnapshot> | null, verifiedBefore: string[], verifiedAfter: string[], actor?: AuditActorContext) {
    await tx.auditLog.create({ data: auditRecordData({ ...actor, action, resourceType: 'organization', resourceId: organizationId, statusCode: action === 'organization.domain.remove' ? 200 : 201,
      detail: { transactional: true, targets: { domainId: (after || before)?.id }, outcome: { domainId: (after || before)?.id },
        before: { domain: before, verifiedDomains: [...verifiedBefore] }, after: { domain: after, verifiedDomains: [...verifiedAfter] } } }) });
  }
  protected async resolveDomainTxt(host: string) { return new Resolver({ timeout: 5000, tries: 2 }).resolveTxt(host); }
  async createInvitation(organizationId: string, invitedById: string, input: CreateOrganizationInvitationDto, actorId?: string, auditActor?: AuditActorContext) {
    return this.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
    if (actorId) {
      const actor = await this.requireManager(tx, organizationId, actorId);
      if (actorId !== invitedById || (actor.role === 'admin' && input.role && input.role !== 'member')) throw new ForbiddenException({ code: 'ORGANIZATION_ROLE_FORBIDDEN', message: '管理员只能邀请普通成员' });
    }
    if (input.role && !['admin', 'auditor', 'member'].includes(input.role)) throw new BadRequestException('邀请角色无效');
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } }); const email = normalizeEmail(input.email); const now = new Date();
    if (actorId) {
      const actor = await this.requireManager(tx, organizationId, actorId);
      if (actor.role === 'admin' && await tx.organizationInvitation.findFirst({ where: { organizationId, email, role: { not: 'member' }, status: 'pending' } })) throw new ForbiddenException({ code: 'ORGANIZATION_ROLE_FORBIDDEN', message: '管理员不能替换管理或审计角色邀请' });
    }
    const existingUser = await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
    if (existingUser && await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: existingUser.id } } })) throw new BadRequestException({ code: 'ORGANIZATION_MEMBER_EXISTS', message: '该用户已经是组织成员' });
    const activeSeats = await tx.organizationMember.count({ where: { organizationId, status: 'active' } });
    const pendingInvitations = await tx.organizationInvitation.count({ where: { organizationId, email: { not: email }, status: 'pending', expiresAt: { gt: now } } });
    if (activeSeats + pendingInvitations >= organization.seatLimit) throw new ForbiddenException({ code: 'ORGANIZATION_SEAT_LIMIT', message: `组织席位上限为 ${organization.seatLimit}` });
    const replaced = (await tx.organizationInvitation.findMany({ where: { organizationId, email, status: 'pending' } })).map(invitationAuditSnapshot);
    await tx.organizationInvitation.updateMany({ where: { organizationId, email, status: 'pending' }, data: { status: 'revoked' } });
    const token = randomBytes(32).toString('base64url');
    const invitation = await tx.organizationInvitation.create({ data: { organizationId, email, role: input.role ?? 'member', tokenHash: invitationHash(token), invitedById, expiresAt: new Date(now.getTime() + (input.expiresInDays ?? 7) * 86400_000) } });
    await tx.auditLog.create({ data: auditRecordData({ ...(auditActor || { actorId: invitedById }), action: 'organization.invitation.create', resourceType: 'organization', resourceId: organizationId, statusCode: 201,
      detail: { transactional: true, targets: { invitationId: invitation.id }, outcome: { invitationId: invitation.id, role: invitation.role },
        before: { invitations: replaced }, after: { invitations: [...replaced.map(row => ({ ...row, status: 'revoked' })), invitationAuditSnapshot(invitation)] } } }) });
    return { ...publicInvitation(invitation), token };
    });
  }
  async revokeInvitation(organizationId: string, invitationId: string, actorId?: string, auditActor?: AuditActorContext) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
      const actor = actorId ? await this.requireManager(tx, organizationId, actorId) : null;
      if (!actorId && !await tx.organization.findUnique({ where: { id: organizationId } })) throw new NotFoundException({ code: 'ORGANIZATION_NOT_FOUND', message: '组织不存在' });
      const invitation = await tx.organizationInvitation.findFirst({ where: { id: invitationId, organizationId, status: 'pending' } });
      if (!invitation) throw new NotFoundException({ code: 'ORGANIZATION_INVITATION_NOT_FOUND', message: '待处理邀请不存在' });
      if (actor?.role === 'admin' && invitation.role !== 'member') throw new ForbiddenException({ code: 'ORGANIZATION_ROLE_FORBIDDEN', message: '管理员不能撤销管理角色邀请' });
      const before = invitationAuditSnapshot(invitation);
      const result = await tx.organizationInvitation.updateMany({ where: { id: invitationId, organizationId, status: 'pending' }, data: { status: 'revoked' } });
      if (!result.count) throw new NotFoundException({ code: 'ORGANIZATION_INVITATION_NOT_FOUND', message: '待处理邀请不存在' });
      await tx.auditLog.create({ data: auditRecordData({ ...(auditActor || { actorId }), action: 'organization.invitation.revoke', resourceType: 'organization', resourceId: organizationId, statusCode: 200,
        detail: { transactional: true, targets: { invitationId }, before, after: { ...before, status: 'revoked' } } }) });
      return { success: true };
    });
  }
  async acceptInvitation(user: AuthUser, token: string, auditActor?: AuditActorContext) {
    if (!user.email) throw new BadRequestException({ code: 'ORGANIZATION_INVITATION_EMAIL_REQUIRED', message: '当前账户没有邮箱，无法接受企业邀请' });
    const tokenHash = invitationHash(token);
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.organizationInvitation.findUnique({ where: { tokenHash } });
      if (candidate) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${candidate.organizationId}))`;
      const invitation = candidate ? await tx.organizationInvitation.findUnique({ where: { tokenHash }, include: { organization: true } }) : null;
      const now = new Date();
      if (!invitation || invitation.status !== 'pending' || invitation.expiresAt <= now) throw new NotFoundException({ code: 'ORGANIZATION_INVITATION_INVALID', message: '邀请不存在、已失效或已被使用' });
      if (normalizeEmail(user.email!) !== invitation.email) throw new ForbiddenException({ code: 'ORGANIZATION_INVITATION_EMAIL_MISMATCH', message: '请使用收到邀请的邮箱账户登录' });
      const existing = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: invitation.organizationId, userId: user.id } } });
      const before = { invitation: invitationAuditSnapshot(invitation), membership: memberAuditSnapshot(existing) };
      if (existing?.status !== 'active' && await tx.organizationMember.count({ where: { organizationId: invitation.organizationId, status: 'active' } }) >= invitation.organization.seatLimit) throw new ForbiddenException({ code: 'ORGANIZATION_SEAT_LIMIT', message: `组织席位上限为 ${invitation.organization.seatLimit}` });
      const claimed = await tx.organizationInvitation.updateMany({ where: { id: invitation.id, status: 'pending', expiresAt: { gt: now } }, data: { status: 'accepted', acceptedAt: now, acceptedById: user.id } });
      if (!claimed.count) throw new NotFoundException({ code: 'ORGANIZATION_INVITATION_INVALID', message: '邀请已被其他请求使用' });
      const membership = await tx.organizationMember.upsert({ where: { organizationId_userId: { organizationId: invitation.organizationId, userId: user.id } }, create: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role, status: 'active' }, update: { status: 'active' } });
      await tx.auditLog.create({ data: auditRecordData({ ...auditActor, actorId: user.id, actorName: user.username || auditActor?.actorName || 'user', action: 'organization.invitation.accept', resourceType: 'organization', resourceId: invitation.organizationId, statusCode: 201,
        detail: { transactional: true, targets: { invitationId: invitation.id, userId: user.id }, outcome: { userId: membership.userId, role: membership.role }, before,
          after: { invitation: { ...before.invitation, status: 'accepted', acceptedAt: now.toISOString(), acceptedById: user.id }, membership: memberAuditSnapshot(membership) } } }) });
      return { organization: { id: invitation.organization.id, name: invitation.organization.name }, membership };
    }, { isolationLevel: 'ReadCommitted' });
  }
  async managedPolicy(organizationId: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.requireManager(tx, organizationId, actorId);
      const policy = await tx.enterprisePolicy.findUnique({ where: { organizationId } });
      if (!policy) throw new NotFoundException({ code: 'ENTERPRISE_POLICY_NOT_FOUND', message: '组织尚未配置客户端策略' });
      return policy;
    });
  }
  async updatePolicy(organizationId: string, input: UpdateEnterprisePolicyDto, actorId?: string, expectedUpdatedAt?: string, auditActor?: AuditActorContext) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
      if (actorId) {
        const actor = await this.requireManager(tx, organizationId, actorId);
        if (actor.role !== 'owner') throw new ForbiddenException({ code: 'ORGANIZATION_POLICY_FORBIDDEN', message: '仅组织所有者可以修改安全策略' });
        if (!expectedUpdatedAt || !Number.isFinite(new Date(expectedUpdatedAt).getTime())) throw new BadRequestException('请提供当前策略版本');
      } else if (!await tx.organization.findUnique({ where: { id: organizationId } })) throw new NotFoundException({ code: 'ORGANIZATION_NOT_FOUND', message: '组织不存在' });
      const current = await tx.enterprisePolicy.findUnique({ where: { organizationId } });
      if (actorId && (!current || current.updatedAt.getTime() !== new Date(expectedUpdatedAt!).getTime())) throw new ConflictException({ code: 'ORGANIZATION_POLICY_CONFLICT', message: '策略已被更新，请重新读取后再保存' });
      const policy = normalizePolicy(input);
      const updatedAt = new Date(Math.max(Date.now(), (current?.updatedAt.getTime() || 0) + 1));
      const before = policyAuditSnapshot(current);
      const result = await tx.enterprisePolicy.upsert({ where: { organizationId }, create: { organizationId, ...policy, updatedAt }, update: { ...policy, updatedAt } });
      await tx.auditLog.create({ data: auditRecordData({ ...(auditActor || { actorId }), action: 'organization.policy.update', resourceType: 'organization', resourceId: organizationId,
        result: 'success', statusCode: 200, detail: { before, after: policyAuditSnapshot(result), transactional: true } }) });
      return result;
    });
  }
  async issueForUser(userId: string) {
    const now = new Date(); const subscription = await this.prisma.licenseSubscription.findUnique({ where: { userId } });
    if (!subscription || subscription.edition !== 'enterprise' || subscription.status !== 'active' || subscription.expiresAt <= now) throw new ForbiddenException({ code: 'ENTERPRISE_LICENSE_REQUIRED', message: '当前账号没有有效的 Enterprise 套餐' });
    const membership = await this.prisma.organizationMember.findFirst({ where: { userId, status: 'active' }, include: { organization: { include: { policy: true } } }, orderBy: { createdAt: 'asc' } });
    if (!membership) throw new NotFoundException({ code: 'ORGANIZATION_MEMBERSHIP_NOT_FOUND', message: '当前账号尚未加入企业组织' });
    const policy = membership.organization.policy; if (!policy) throw new NotFoundException({ code: 'ENTERPRISE_POLICY_NOT_FOUND', message: '企业尚未配置客户端策略' });
    const issuedAt = Math.floor(now.getTime() / 1000); const expiresAt = issuedAt + 86400; const offlineUntil = expiresAt + policy.offlineDays * 86400;
    let token: string; try { token = signEnterprisePolicy({ organizationId: membership.organizationId, issuedAt, expiresAt, offlineUntil, policy: publicPolicy(policy) }, this.config.get<string>('POLICY_ED25519_PRIVATE_KEY', ''), this.config.get<string>('POLICY_KEY_ID', 'primary')); } catch (error) { throw new ServiceUnavailableException(error instanceof Error ? error.message : '企业策略签发暂不可用'); }
    return { token, organization: { id: membership.organization.id, name: membership.organization.name }, expiresAt: new Date(expiresAt * 1000), offlineUntil: new Date(offlineUntil * 1000) };
  }
  private async requireOrganization(id: string) { const organization = await this.prisma.organization.findUnique({ where: { id } }); if (!organization) throw new NotFoundException({ code: 'ORGANIZATION_NOT_FOUND', message: '组织不存在' }); return organization; }
}
function invitationHash(token: string) { return createHash('sha256').update(token, 'utf8').digest('hex'); }
function domainAuditSnapshot(domain: { id: string; organizationId: string; domain: string; expiresAt: Date; verifiedAt: Date | null }) {
  return { id: domain.id, organizationId: domain.organizationId, domain: domain.domain, expiresAt: domain.expiresAt.toISOString(), verifiedAt: domain.verifiedAt?.toISOString() ?? null };
}
function invitationAuditSnapshot(invitation: { id: string; organizationId: string; role: string; status: string; expiresAt: Date; invitedById: string; acceptedById?: string | null; acceptedAt?: Date | null }) {
  return { id: invitation.id, organizationId: invitation.organizationId, role: invitation.role, status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(), invitedById: invitation.invitedById,
    acceptedById: invitation.acceptedById ?? null, acceptedAt: invitation.acceptedAt?.toISOString() ?? null };
}
function normalizeDomain(value: string) {
  const domain = domainToASCII(value.trim().toLowerCase());
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) || /\.(?:localhost|local|internal|test|invalid|example)$/.test(domain)) throw new BadRequestException({ code: 'ORGANIZATION_DOMAIN_INVALID', message: '请输入有效的公共域名，例如 company.com' });
  return domain;
}
function domainInstructions<T extends { domain: string; token: string }>(row: T) { return { ...row, recordName: `_code-studio-verification.${row.domain}`, recordType: 'TXT', recordValue: `code-studio-verification=${row.token}` }; }
function normalizeEmail(value: string) { return value.trim().toLowerCase(); }
function publicInvitation<T extends { tokenHash: string }>(invitation: T) { const { tokenHash: _tokenHash, ...safe } = invitation; return safe; }
function normalizePolicy(input: UpdateEnterprisePolicyDto) {
  const engine = (value: string) => /^[a-z][a-z0-9-]{0,49}$/.test(value); const host = (value: string) => /^(?:local|[a-z0-9.-]{1,253})$/i.test(value);
  if (input.allowedModelEngines.some((value) => !engine(value)) || input.allowedConnectorTypes.some((value) => !engine(value)) || input.allowedGitHosts.some((value) => !host(value)) || input.allowedNetworkHosts.some((value) => !host(value) || value.toLowerCase() === 'local')) throw new BadRequestException({ code: 'ENTERPRISE_POLICY_INVALID', message: '企业策略白名单包含无效值' });
  const unique = (values: string[]) => [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]; return { terminalEnabled: input.terminalEnabled, allowedModelEngines: unique(input.allowedModelEngines), allowedConnectorTypes: unique(input.allowedConnectorTypes), allowedGitHosts: unique(input.allowedGitHosts), allowedNetworkHosts: unique(input.allowedNetworkHosts), minimumClientVersion: input.minimumClientVersion, offlineDays: input.offlineDays };
}
function policyAuditSnapshot(policy: (UpdateEnterprisePolicyDto & { updatedAt: Date }) | null) {
  if (!policy) return null;
  // Copy only policy fields; never retain mutable array references or DTO extras.
  return { terminalEnabled: policy.terminalEnabled, allowedModelEngines: [...policy.allowedModelEngines],
    allowedConnectorTypes: [...policy.allowedConnectorTypes], allowedGitHosts: [...policy.allowedGitHosts],
    allowedNetworkHosts: [...policy.allowedNetworkHosts], minimumClientVersion: policy.minimumClientVersion,
    offlineDays: policy.offlineDays, updatedAt: policy.updatedAt.toISOString() };
}
function publicPolicy(policy: { terminalEnabled: boolean; allowedModelEngines: string[]; allowedConnectorTypes: string[]; allowedGitHosts: string[]; allowedNetworkHosts: string[]; minimumClientVersion: string }) { return { terminalEnabled: policy.terminalEnabled, allowedModelEngines: policy.allowedModelEngines, allowedConnectorTypes: policy.allowedConnectorTypes, allowedGitHosts: policy.allowedGitHosts, allowedNetworkHosts: policy.allowedNetworkHosts, minimumClientVersion: policy.minimumClientVersion }; }
