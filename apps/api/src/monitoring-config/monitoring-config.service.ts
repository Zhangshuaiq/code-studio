import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';

export type MonitoringKind = 'opensearch' | 'prometheus' | 'tempo';
export type MonitoringAuthType = 'none' | 'basic' | 'bearer';
export interface MonitoringConfigInput {
  enabled: boolean;
  url: string;
  authType: MonitoringAuthType;
  username?: string;
  secret?: string;
  clearSecret?: boolean;
}
interface StoredConfig extends Omit<MonitoringConfigInput, 'secret' | 'clearSecret'> { encryptedSecret?: string }
export interface ResolvedMonitoringConfig {
  enabled: boolean;
  configured: boolean;
  source: 'interface' | 'environment' | 'none';
  url: string;
  headers: Record<string, string>;
}

const KEY_PREFIX = 'monitoring.connection.';
const KINDS: MonitoringKind[] = ['opensearch', 'prometheus', 'tempo'];

@Injectable()
export class MonitoringConfigService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly env: ConfigService) {}

  async list() { return Promise.all(KINDS.map((kind) => this.safe(kind))); }

  async save(kind: MonitoringKind, input: MonitoringConfigInput, userId: string) {
    this.assertKind(kind);
    const url = normalizeUrl(input.url);
    const authType = assertAuthType(input.authType);
    const current = await this.stored(kind);
    const encryptedSecret = input.clearSecret
      ? undefined
      : input.secret
        ? this.crypto.encrypt(input.secret)
        : current?.encryptedSecret;
    if (authType === 'basic' && !input.username?.trim()) throw new BadRequestException('Basic 鉴权必须填写用户名');
    if (authType !== 'none' && !encryptedSecret) throw new BadRequestException('当前鉴权方式必须填写密码或 Token');
    const value: StoredConfig = { enabled: input.enabled, url, authType, username: input.username?.trim() || undefined, encryptedSecret };
    await this.prisma.systemSetting.upsert({ where: { key: `${KEY_PREFIX}${kind}` }, create: { key: `${KEY_PREFIX}${kind}`, value: value as never, updatedById: userId }, update: { value: value as never, updatedById: userId } });
    return this.safe(kind);
  }

  async test(kind: MonitoringKind, input?: MonitoringConfigInput) {
    this.assertKind(kind);
    const resolved = input ? this.resolveInput(input) : await this.resolve(kind);
    if (!resolved.enabled || !resolved.configured) throw new BadRequestException('请先启用并填写服务地址');
    const path = kind === 'opensearch' ? '/' : kind === 'prometheus' ? '/-/ready' : '/ready';
    const started = Date.now();
    try {
      const response = await fetch(`${resolved.url}${path}`, { headers: resolved.headers, signal: AbortSignal.timeout(5000) });
      return { ok: response.ok, status: response.status, latencyMs: Date.now() - started, message: response.ok ? '连接成功' : `服务返回 HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, message: error instanceof Error ? error.message : '连接失败' };
    }
  }

  async resolve(kind: MonitoringKind): Promise<ResolvedMonitoringConfig> {
    const stored = await this.stored(kind);
    if (stored) return this.resolveStored(stored, 'interface');
    const url = this.env.get<string>(envKey(kind), '').trim();
    if (!url) return { enabled: false, configured: false, source: 'none', url: '', headers: {} };
    const username = this.env.get<string>(`${envPrefix(kind)}_USERNAME`, '');
    const password = this.env.get<string>(`${envPrefix(kind)}_PASSWORD`, '');
    const bearer = this.env.get<string>(`${envPrefix(kind)}_BEARER_TOKEN`, '');
    return { enabled: true, configured: true, source: 'environment', url: normalizeUrl(url), headers: bearer ? { authorization: `Bearer ${bearer}` } : username ? basicHeaders(username, password) : {} };
  }

  private async safe(kind: MonitoringKind) {
    const resolved = await this.resolve(kind);
    const stored = await this.stored(kind);
    return { kind, enabled: resolved.enabled, configured: resolved.configured, source: resolved.source, url: resolved.url, authType: stored?.authType || inferEnvAuth(this.env, kind), username: stored?.username || '', hasSecret: Boolean(stored?.encryptedSecret || envHasSecret(this.env, kind)) };
  }
  private async stored(kind: MonitoringKind) { const row = await this.prisma.systemSetting.findUnique({ where: { key: `${KEY_PREFIX}${kind}` } }); return row?.value as unknown as StoredConfig | undefined; }
  private resolveStored(value: StoredConfig, source: 'interface'): ResolvedMonitoringConfig { const secret = value.encryptedSecret ? this.crypto.decrypt(value.encryptedSecret) : ''; return { enabled: value.enabled, configured: Boolean(value.url), source, url: normalizeUrl(value.url), headers: authHeaders(value.authType, value.username || '', secret) }; }
  private resolveInput(input: MonitoringConfigInput): ResolvedMonitoringConfig { const url = normalizeUrl(input.url); return { enabled: input.enabled, configured: Boolean(url), source: 'interface', url, headers: authHeaders(assertAuthType(input.authType), input.username || '', input.secret || '') }; }
  private assertKind(kind: string): asserts kind is MonitoringKind { if (!KINDS.includes(kind as MonitoringKind)) throw new BadRequestException('不支持的监控配置类型'); }
}

function normalizeUrl(raw: string) { const value = raw.trim().replace(/\/+$/, ''); if (!value) return ''; let url: URL; try { url = new URL(value); } catch { throw new BadRequestException('服务地址格式不正确'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BadRequestException('服务地址必须是无内嵌凭证的 HTTP/HTTPS URL'); return url.toString().replace(/\/$/, ''); }
function assertAuthType(value: string): MonitoringAuthType { if (!['none', 'basic', 'bearer'].includes(value)) throw new BadRequestException('不支持的鉴权方式'); return value as MonitoringAuthType; }
function basicHeaders(username: string, password: string) { return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }; }
function authHeaders(type: MonitoringAuthType, username: string, secret: string) { return type === 'bearer' ? { authorization: `Bearer ${secret}` } : type === 'basic' ? basicHeaders(username, secret) : {}; }
function envPrefix(kind: MonitoringKind) { return kind === 'opensearch' ? 'OPENSEARCH' : kind === 'prometheus' ? 'PROMETHEUS' : 'TEMPO'; }
function envKey(kind: MonitoringKind) { return `${envPrefix(kind)}_URL`; }
function envHasSecret(env: ConfigService, kind: MonitoringKind) { const prefix = envPrefix(kind); return Boolean(env.get<string>(`${prefix}_PASSWORD`, '') || env.get<string>(`${prefix}_BEARER_TOKEN`, '')); }
function inferEnvAuth(env: ConfigService, kind: MonitoringKind): MonitoringAuthType { const prefix = envPrefix(kind); return env.get(`${prefix}_BEARER_TOKEN`, '') ? 'bearer' : env.get(`${prefix}_USERNAME`, '') ? 'basic' : 'none'; }
