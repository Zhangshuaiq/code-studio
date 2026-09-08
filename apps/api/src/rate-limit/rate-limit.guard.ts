import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { RateLimitService } from './rate-limit.service';

export interface RateLimitPolicy {
  name: 'general' | 'auth' | 'routing';
  limit: number;
  windowMs: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext) {
    if (this.config.get<string>('RATE_LIMIT_ENABLED', 'true') === 'false') return true;
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const path = request.originalUrl?.split('?')[0] ?? request.url;
    if (path.endsWith('/health/live') || path.endsWith('/health/ready')) return true;
    const policy = rateLimitPolicy(path, request.method, this.config);
    const ipIdentity = digest(request.ip || request.socket.remoteAddress || 'unknown');
    const identifiers = policy.name === 'auth'
      ? [
          `auth-ip:${ipIdentity}`,
          ...accountIdentifier(request).map((value) => `auth-account:${digest(value)}`),
        ]
      : [`${policy.name}:${ipIdentity}`];
    try {
      const usages = await Promise.all(
        identifiers.map((identifier) => this.limiter.consume(identifier, policy.windowMs)),
      );
      const usage = usages.reduce((highest, current) =>
        current.count > highest.count ? current : highest,
      );
      response.setHeader('RateLimit-Limit', policy.limit);
      response.setHeader('RateLimit-Remaining', Math.max(0, policy.limit - usage.count));
      response.setHeader('RateLimit-Reset', Math.ceil(usage.ttlMs / 1_000));
      if (usage.count > policy.limit) {
        response.setHeader('Retry-After', Math.max(1, Math.ceil(usage.ttlMs / 1_000)));
        throw new HttpException('请求过于频繁，请稍后重试', 429);
      }
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`分布式限流不可用: ${(error as Error).message}`);
      if (policy.name === 'auth' || this.config.get<string>('RATE_LIMIT_FAIL_OPEN', 'true') === 'false') {
        throw new ServiceUnavailableException('安全限流服务暂不可用');
      }
      return true;
    }
  }
}

function digest(value: string) {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

function accountIdentifier(request: Request) {
  const body = request.body as { username?: unknown; email?: unknown } | undefined;
  const value = typeof body?.username === 'string'
    ? body.username
    : typeof body?.email === 'string'
      ? body.email
      : '';
  return value.trim() ? [value] : [];
}

export function rateLimitPolicy(path: string, method: string, config: Pick<ConfigService, 'get'>): RateLimitPolicy {
  const auth = method === 'POST' && (path.endsWith('/auth/login') || path.endsWith('/auth/register'));
  const routing = method === 'GET' && path.endsWith('/internal/preview-routing/resolve');
  return auth
    ? {
        name: 'auth',
        limit: Number(config.get('RATE_LIMIT_AUTH_MAX', 10)),
        windowMs: Number(config.get('RATE_LIMIT_AUTH_WINDOW_MS', 15 * 60_000)),
      }
    : routing
      ? {
        name: 'routing',
        limit: Number(config.get('RATE_LIMIT_ROUTING_MAX', 6_000)),
        windowMs: Number(config.get('RATE_LIMIT_ROUTING_WINDOW_MS', 60_000)),
      }
      : {
        name: 'general',
        limit: Number(config.get('RATE_LIMIT_MAX', 300)),
        windowMs: Number(config.get('RATE_LIMIT_WINDOW_MS', 60_000)),
      };
}
