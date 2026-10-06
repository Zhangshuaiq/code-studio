import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ActivateLicenseDto, AssignSubscriptionDto, CreateRedeemCodeDto } from './dto/license.dto';
import { signLicenseToken } from './license-token';

const ENTITLEMENTS: Record<string, string[]> = {
  'personal-pro': ['cloud.sync'],
  team: ['cloud.sync', 'remote.execution', 'team.collaboration'],
  enterprise: ['cloud.sync', 'remote.execution', 'team.collaboration', 'enterprise.rbac', 'enterprise.audit', 'enterprise.policies'],
};

@Injectable()
export class LicenseService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  subscription(userId: string) { return this.prisma.licenseSubscription.findUnique({ where: { userId } }); }

  devices(userId: string) {
    return this.prisma.licenseDevice.findMany({ where: { userId }, select: { id: true, deviceId: true, name: true, platform: true, appVersion: true, lastSeenAt: true, revokedAt: true, createdAt: true }, orderBy: { lastSeenAt: 'desc' } });
  }

  async activate(userId: string, input: ActivateLicenseDto) {
    const now = new Date();
    const subscription = await this.subscription(userId);
    if (!subscription) throw new NotFoundException({ code: 'LICENSE_SUBSCRIPTION_NOT_FOUND', message: '当前账号没有可用套餐' });
    if (subscription.status !== 'active') throw new ForbiddenException({ code: 'LICENSE_SUBSCRIPTION_INACTIVE', message: '当前套餐不可用' });
    if (subscription.expiresAt <= now) throw new ForbiddenException({ code: 'LICENSE_SUBSCRIPTION_EXPIRED', message: '当前套餐已到期' });
    const device = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${'license:user:' + userId}))`;
      const existing = await tx.licenseDevice.findUnique({ where: { userId_deviceId: { userId, deviceId: input.deviceId } } });
      if (!existing || existing.revokedAt) {
        const active = await tx.licenseDevice.count({ where: { userId, revokedAt: null } });
        if (active >= subscription.maxDevices) throw new ForbiddenException({ code: 'LICENSE_DEVICE_LIMIT', message: `最多可激活 ${subscription.maxDevices} 台设备` });
      }
      return tx.licenseDevice.upsert({
        where: { userId_deviceId: { userId, deviceId: input.deviceId } },
        create: { userId, deviceId: input.deviceId, name: input.name, platform: input.platform, appVersion: input.appVersion },
        update: { name: input.name, platform: input.platform, appVersion: input.appVersion, lastSeenAt: now, revokedAt: null },
      });
    });
    const iat = Math.floor(now.getTime() / 1000); const exp = Math.floor(subscription.expiresAt.getTime() / 1000);
    let token: string;
    try { token = signLicenseToken({ sub: userId, deviceId: device.deviceId, edition: subscription.edition, iat, exp, graceUntil: exp + subscription.graceDays * 86400, entitlements: ENTITLEMENTS[subscription.edition] || [] }, this.config.get<string>('LICENSE_ED25519_PRIVATE_KEY', ''), this.config.get<string>('LICENSE_KEY_ID', 'primary')); }
    catch (error) { throw new ServiceUnavailableException(error instanceof Error ? error.message : '许可证签发暂不可用'); }
    return { token, edition: subscription.edition, expiresAt: subscription.expiresAt, deviceId: device.deviceId };
  }

  async revoke(userId: string, deviceRecordId: string) {
    const device = await this.prisma.licenseDevice.findFirst({ where: { id: deviceRecordId, userId } });
    if (!device) throw new NotFoundException({ code: 'LICENSE_DEVICE_NOT_FOUND', message: '设备不存在' });
    await this.prisma.licenseDevice.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    return { success: true };
  }

  assign(input: AssignSubscriptionDto) {
    const expiresAt = new Date(input.expiresAt); if (expiresAt <= new Date()) throw new BadRequestException('套餐到期时间必须晚于当前时间');
    return this.prisma.licenseSubscription.upsert({ where: { userId: input.userId }, create: { userId: input.userId, edition: input.edition, expiresAt, status: input.status, graceDays: input.graceDays, maxDevices: input.maxDevices }, update: { edition: input.edition, expiresAt, status: input.status, graceDays: input.graceDays, maxDevices: input.maxDevices } });
  }

  listSubscriptions() {
    return this.prisma.licenseSubscription.findMany({ include: { user: { select: { id: true, username: true, email: true, displayName: true } } }, orderBy: { updatedAt: 'desc' }, take: 1000 });
  }

  async redeem(userId: string, value: string) {
    const normalized = normalizeRedeemCode(value); const codeHash = redeemCodeHash(normalized); const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const initial = await tx.licenseRedeemCode.findUnique({ where: { codeHash } });
      if (!initial) throw new NotFoundException({ code: 'LICENSE_REDEEM_INVALID', message: '兑换码无效' });
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${'license:code:' + initial.id}))`;
      const code = await tx.licenseRedeemCode.findUnique({ where: { id: initial.id } });
      if (!code || code.disabledAt || (code.expiresAt && code.expiresAt <= now)) throw new ForbiddenException({ code: 'LICENSE_REDEEM_EXPIRED', message: '兑换码已失效' });
      if (code.redemptionCount >= code.maxRedemptions) throw new ForbiddenException({ code: 'LICENSE_REDEEM_EXHAUSTED', message: '兑换码使用次数已达上限' });
      if (await tx.licenseRedemption.findUnique({ where: { codeId_userId: { codeId: code.id, userId } } })) throw new BadRequestException({ code: 'LICENSE_REDEEM_REPLAYED', message: '当前账号已经使用过此兑换码' });
      const current = await tx.licenseSubscription.findUnique({ where: { userId } });
      const base = current?.expiresAt && current.expiresAt > now ? current.expiresAt : now;
      const expiresAt = new Date(base.getTime() + code.durationDays * 86400_000);
      const subscription = await tx.licenseSubscription.upsert({ where: { userId }, create: { userId, edition: code.edition, status: 'active', expiresAt, graceDays: code.graceDays, maxDevices: code.maxDevices }, update: { edition: code.edition, status: 'active', expiresAt, graceDays: code.graceDays, maxDevices: code.maxDevices } });
      await tx.licenseRedemption.create({ data: { codeId: code.id, userId } });
      await tx.licenseRedeemCode.update({ where: { id: code.id }, data: { redemptionCount: { increment: 1 } } });
      return subscription;
    });
  }

  async createRedeemCode(input: CreateRedeemCodeDto) {
    const raw = randomBytes(16).toString('hex').toUpperCase(); const code = `CS-${raw.match(/.{1,4}/g)?.join('-')}`;
    const record = await this.prisma.licenseRedeemCode.create({ data: { codeHash: redeemCodeHash(normalizeRedeemCode(code)), codePrefix: code.slice(0, 12), edition: input.edition, durationDays: input.durationDays, graceDays: input.graceDays, maxDevices: input.maxDevices, maxRedemptions: input.maxRedemptions, expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined } });
    return { ...publicRedeemCode(record), code };
  }

  async listRedeemCodes() {
    return (await this.prisma.licenseRedeemCode.findMany({ orderBy: { createdAt: 'desc' }, take: 500 })).map(publicRedeemCode);
  }

  async disableRedeemCode(id: string) {
    const existing = await this.prisma.licenseRedeemCode.findUnique({ where: { id } }); if (!existing) throw new NotFoundException('兑换码不存在');
    await this.prisma.licenseRedeemCode.update({ where: { id }, data: { disabledAt: new Date() } }); return { success: true };
  }

  async issueOffline(userId: string, input: unknown) {
    const challenge = validateOfflineChallenge(input); const now = new Date();
    const subscription = await this.prisma.licenseSubscription.findUnique({ where: { userId } });
    if (!subscription || subscription.status !== 'active' || subscription.expiresAt <= now) throw new ForbiddenException({ code: 'LICENSE_SUBSCRIPTION_INACTIVE', message: '用户没有可用套餐' });
    const iat = Math.floor(now.getTime() / 1000); const exp = Math.floor(subscription.expiresAt.getTime() / 1000);
    let token: string;
    try { token = signLicenseToken({ sub: userId, deviceId: challenge.deviceId, edition: subscription.edition, iat, exp, graceUntil: exp + subscription.graceDays * 86400, entitlements: ENTITLEMENTS[subscription.edition] || [], challengeNonce: challenge.nonce }, this.config.get<string>('LICENSE_ED25519_PRIVATE_KEY', ''), this.config.get<string>('LICENSE_KEY_ID', 'primary')); }
    catch (error) { throw new ServiceUnavailableException(error instanceof Error ? error.message : '许可证签发暂不可用'); }
    return { format: 'code-studio-license-v1', challengeNonce: challenge.nonce, token };
  }
}

function normalizeRedeemCode(value: string) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[A-Z0-9]{12,96}$/.test(normalized)) throw new BadRequestException({ code: 'LICENSE_REDEEM_INVALID', message: '兑换码格式无效' });
  return normalized;
}
function redeemCodeHash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function publicRedeemCode<T extends { codeHash: string }>(record: T) { const { codeHash: _codeHash, ...result } = record; return result; }

function validateOfflineChallenge(input: unknown) {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (value.format !== 'code-studio-license-request-v1' || typeof value.deviceId !== 'string' || value.deviceId.length < 16 || value.deviceId.length > 256 || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.nonce) || typeof value.createdAt !== 'string') throw new BadRequestException({ code: 'LICENSE_CHALLENGE_INVALID', message: '离线许可证申请文件无效' });
  const createdAt = Date.parse(value.createdAt); const now = Date.now(); if (!Number.isFinite(createdAt) || createdAt > now + 300_000 || createdAt < now - 30 * 86400_000) throw new BadRequestException({ code: 'LICENSE_CHALLENGE_EXPIRED', message: '离线许可证申请已过期，请重新导出' });
  return { deviceId: value.deviceId, nonce: value.nonce };
}
