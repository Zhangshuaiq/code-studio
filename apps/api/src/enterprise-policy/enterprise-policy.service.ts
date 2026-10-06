import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { PrismaService } from '../prisma/prisma.service';
import { AddOrganizationMemberDto, CreateOrganizationDto, CreateOrganizationInvitationDto, UpdateEnterprisePolicyDto } from './dto/enterprise-policy.dto';
import { signEnterprisePolicy } from './enterprise-policy-token';
import type { AuthUser } from '../auth/jwt.strategy';

const DEFAULT_POLICY = { terminalEnabled: true, allowedModelEngines: ['codex-cli', 'claude-code', 'aider', 'openai-compatible', 'ollama'], allowedConnectorTypes: ['postgres', 'mysql', 'kafka', 'kubernetes'], allowedGitHosts: ['local'], allowedNetworkHosts: [], minimumClientVersion: '0.1.0', offlineDays: 7 };

@Injectable()
export class EnterprisePolicyService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}
  organizations() { return this.prisma.organization.findMany({ include: { _count: { select: { members: true } }, policy: true }, orderBy: { createdAt: 'desc' }, take: 1000 }); }
  createOrganization(input: CreateOrganizationDto) { return this.prisma.organization.create({ data: { name: input.name.trim(), slug: input.slug.toLowerCase(), seatLimit: input.seatLimit ?? 10, policy: { create: DEFAULT_POLICY } }, include: { policy: true } }); }
  async members(organizationId: string) { await this.requireOrganization(organizationId); return this.prisma.organizationMember.findMany({ where: { organizationId }, include: { user: { select: { id: true, username: true, email: true, displayName: true } } }, orderBy: { createdAt: 'asc' }, take: 10000 }); }
  async addMember(organizationId: string, input: AddOrganizationMemberDto) {
    return this.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } }); const existing = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: input.userId } } });
    if (existing?.status !== 'active' && await tx.organizationMember.count({ where: { organizationId, status: 'active' } }) >= organization.seatLimit) throw new ForbiddenException({ code: 'ORGANIZATION_SEAT_LIMIT', message: `组织席位上限为 ${organization.seatLimit}` });
    return tx.organizationMember.upsert({ where: { organizationId_userId: { organizationId, userId: input.userId } }, create: { organizationId, userId: input.userId, role: input.role ?? 'member' }, update: { role: input.role ?? existing?.role ?? 'member', status: 'active' } });
    });
  }
  async removeMember(organizationId: string, userId: string) { const member = await this.prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } }); if (!member) throw new NotFoundException({ code: 'ORGANIZATION_MEMBER_NOT_FOUND', message: '组织成员不存在' }); await this.prisma.organizationMember.delete({ where: { id: member.id } }); return { success: true }; }
  async invitations(organizationId: string) {
    await this.requireOrganization(organizationId);
    const rows = await this.prisma.organizationInvitation.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 1000 });
    return rows.map(publicInvitation);
  }
  async domains(organizationId: string) {
    await this.requireOrganization(organizationId);
    return (await this.prisma.organizationDomain.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 100 })).map(domainInstructions);
  }
  async createDomain(organizationId: string, value: string) {
    await this.requireOrganization(organizationId); const domain = normalizeDomain(value);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`domain:${domain}`}))`;
      const existing = await tx.organizationDomain.findUnique({ where: { organizationId_domain: { organizationId, domain } } });
      if (existing?.verifiedAt) return domainInstructions(existing);
      if (await tx.organizationDomain.findFirst({ where: { domain, verifiedAt: { not: null }, organizationId: { not: organizationId } } })) throw new ForbiddenException({ code: 'ORGANIZATION_DOMAIN_CLAIMED', message: '该域名已由其他组织验证' });
      if (!existing && await tx.organizationDomain.count({ where: { organizationId } }) >= 100) throw new BadRequestException('每个组织最多配置 100 个域名');
      const challenge = { token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 7 * 86400_000) };
      return domainInstructions(await tx.organizationDomain.upsert({ where: { organizationId_domain: { organizationId, domain } }, create: { organizationId, domain, ...challenge }, update: challenge }));
    });
  }
  async verifyDomain(organizationId: string, id: string) {
    const challenge = await this.prisma.organizationDomain.findFirst({ where: { id, organizationId } });
    if (!challenge) throw new NotFoundException('域名验证申请不存在');
    if (challenge.verifiedAt) return domainInstructions(challenge);
    if (challenge.expiresAt <= new Date()) throw new BadRequestException({ code: 'ORGANIZATION_DOMAIN_EXPIRED', message: '验证申请已过期，请重新生成记录' });
    let records: string[][];
    try { records = await this.resolveDomainTxt(`_code-studio-verification.${challenge.domain}`); }
    catch { throw new BadRequestException({ code: 'ORGANIZATION_DOMAIN_DNS_UNAVAILABLE', message: '未读取到 DNS TXT 记录，请检查记录并等待 DNS 生效' }); }
    if (!records.some((parts) => parts.join('') === `code-studio-verification=${challenge.token}`)) throw new BadRequestException({ code: 'ORGANIZATION_DOMAIN_TOKEN_MISMATCH', message: 'DNS TXT 记录与当前验证值不一致' });
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`domain:${challenge.domain}`}))`;
      if (await tx.organizationDomain.findFirst({ where: { domain: challenge.domain, verifiedAt: { not: null }, organizationId: { not: organizationId } } })) throw new ForbiddenException({ code: 'ORGANIZATION_DOMAIN_CLAIMED', message: '该域名已由其他组织验证' });
      const claimed = await tx.organizationDomain.updateMany({ where: { id, organizationId, token: challenge.token, expiresAt: { gt: new Date() }, verifiedAt: null }, data: { verifiedAt: new Date() } });
      if (!claimed.count) throw new BadRequestException('验证申请已更新，请重试');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
      const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
      await tx.organization.update({ where: { id: organizationId }, data: { verifiedDomains: [...new Set([...organization.verifiedDomains, challenge.domain])] } });
      return domainInstructions(await tx.organizationDomain.findUniqueOrThrow({ where: { id } }));
    });
  }
  async removeDomain(organizationId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const domain = await tx.organizationDomain.findFirst({ where: { id, organizationId } });
      if (!domain) throw new NotFoundException('域名配置不存在');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`domain:${domain.domain}`}))`;
      await tx.organizationDomain.deleteMany({ where: { id, organizationId } });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
      const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
      await tx.organization.update({ where: { id: organizationId }, data: { verifiedDomains: organization.verifiedDomains.filter((value) => value !== domain.domain) } });
      return { success: true };
    });
  }
  protected async resolveDomainTxt(host: string) { return new Resolver({ timeout: 5000, tries: 2 }).resolveTxt(host); }
  async createInvitation(organizationId: string, invitedById: string, input: CreateOrganizationInvitationDto) {
    return this.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } }); const email = normalizeEmail(input.email); const now = new Date();
    const existingUser = await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
    if (existingUser && await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: existingUser.id } } })) throw new BadRequestException({ code: 'ORGANIZATION_MEMBER_EXISTS', message: '该用户已经是组织成员' });
    const activeSeats = await tx.organizationMember.count({ where: { organizationId, status: 'active' } });
    const pendingInvitations = await tx.organizationInvitation.count({ where: { organizationId, email: { not: email }, status: 'pending', expiresAt: { gt: now } } });
    if (activeSeats + pendingInvitations >= organization.seatLimit) throw new ForbiddenException({ code: 'ORGANIZATION_SEAT_LIMIT', message: `组织席位上限为 ${organization.seatLimit}` });
    await tx.organizationInvitation.updateMany({ where: { organizationId, email, status: 'pending' }, data: { status: 'revoked' } });
    const token = randomBytes(32).toString('base64url');
    const invitation = await tx.organizationInvitation.create({ data: { organizationId, email, role: input.role ?? 'member', tokenHash: invitationHash(token), invitedById, expiresAt: new Date(now.getTime() + (input.expiresInDays ?? 7) * 86400_000) } });
    return { ...publicInvitation(invitation), token };
    });
  }
  async revokeInvitation(organizationId: string, invitationId: string) {
    await this.requireOrganization(organizationId);
    const result = await this.prisma.organizationInvitation.updateMany({ where: { id: invitationId, organizationId, status: 'pending' }, data: { status: 'revoked' } });
    if (!result.count) throw new NotFoundException({ code: 'ORGANIZATION_INVITATION_NOT_FOUND', message: '待处理邀请不存在' });
    return { success: true };
  }
  async acceptInvitation(user: AuthUser, token: string) {
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
      if (existing?.status !== 'active' && await tx.organizationMember.count({ where: { organizationId: invitation.organizationId, status: 'active' } }) >= invitation.organization.seatLimit) throw new ForbiddenException({ code: 'ORGANIZATION_SEAT_LIMIT', message: `组织席位上限为 ${invitation.organization.seatLimit}` });
      const claimed = await tx.organizationInvitation.updateMany({ where: { id: invitation.id, status: 'pending', expiresAt: { gt: now } }, data: { status: 'accepted', acceptedAt: now, acceptedById: user.id } });
      if (!claimed.count) throw new NotFoundException({ code: 'ORGANIZATION_INVITATION_INVALID', message: '邀请已被其他请求使用' });
      const membership = await tx.organizationMember.upsert({ where: { organizationId_userId: { organizationId: invitation.organizationId, userId: user.id } }, create: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role, status: 'active' }, update: { status: 'active' } });
      return { organization: { id: invitation.organization.id, name: invitation.organization.name }, membership };
    }, { isolationLevel: 'ReadCommitted' });
  }
  async updatePolicy(organizationId: string, input: UpdateEnterprisePolicyDto) { await this.requireOrganization(organizationId); const policy = normalizePolicy(input); return this.prisma.enterprisePolicy.upsert({ where: { organizationId }, create: { organizationId, ...policy }, update: policy }); }
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
function publicPolicy(policy: { terminalEnabled: boolean; allowedModelEngines: string[]; allowedConnectorTypes: string[]; allowedGitHosts: string[]; allowedNetworkHosts: string[]; minimumClientVersion: string }) { return { terminalEnabled: policy.terminalEnabled, allowedModelEngines: policy.allowedModelEngines, allowedConnectorTypes: policy.allowedConnectorTypes, allowedGitHosts: policy.allowedGitHosts, allowedNetworkHosts: policy.allowedNetworkHosts, minimumClientVersion: policy.minimumClientVersion }; }
