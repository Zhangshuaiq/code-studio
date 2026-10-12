import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { AUDIT_KEY, AuditMeta } from './audit.decorator';
import { AuditService } from './audit.service';
import { AuthUser } from '../auth/jwt.strategy';

// 敏感字段键名（脱敏，绝不落库）
const SECRET_KEY_RE =
  /pass(word)?|passwordhash|passphrase|token|privatekey|kubeconfig|api[-_]?key|secret|cred|authorization/i;

function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '***' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMeta>(AUDIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!meta) return next.handle();

    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const user = req.user as AuthUser | undefined;
    // Express applies configured trusted proxies to req.ip. Do not trust an
    // arbitrary caller-supplied forwarding header as forensic evidence.
    const ip =
      req.ip ||
      req.socket?.remoteAddress ||
      null;
    const base = {
      action: meta.action,
      resourceType: meta.resourceType ?? null,
      resourceId: req.params?.id ?? null,
      actorId: user?.id ?? null,
      actorName: user?.username ?? 'anonymous',
      ip,
      method: req.method,
      // URL query strings can carry challenges, API keys or invitation codes.
      path: String(req.originalUrl || req.url || '').split('?')[0],
      detail: meta.targetParams?.length
        ? { body: meta.includeBody === false ? { bodyOmitted: true } : redact(req.body), targets: Object.fromEntries(meta.targetParams.filter((key) => req.params?.[key] !== undefined).map((key) => [key, req.params[key]])) }
        : meta.includeBody === false ? { bodyOmitted: true } : redact(req.body),
    };

    return next.handle().pipe(
      tap((body) => {
        // The domain transaction already persisted the success row atomically.
        // Failed transactions still reach catchError below for best-effort logs.
        if (meta.transactionalSuccess) return;
        const outcome = Object.fromEntries(Object.entries(meta.resultFields || {}).map(([key, fieldPath]) => [key, fieldPath.split('.').reduce((value: any, part) => value?.[part], body)]).filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'));
        this.audit.record({
          ...base,
          result: 'success',
          statusCode: res.statusCode,
          ...(Object.keys(outcome).length ? { detail: { ...(base.detail as object), outcome } } : {}),
          // 结果里若带资源名/id，补齐便于检索
          resourceName:
            (body?.name as string) ?? (body?.username as string) ?? null,
          resourceId: base.resourceId ?? (body?.organization?.id as string) ?? (body?.id as string) ?? null,
        });
      }),
      catchError((err) => {
        this.audit.record({
          ...base,
          result: 'failure',
          statusCode: err?.status ?? err?.statusCode ?? 500,
          // For sensitive-body routes even the exception text may echo input.
          detail: { ...(base.detail as object), error: meta.includeBody === false ? '敏感操作失败，具体错误不进入审计日志' : err?.message },
        });
        return throwError(() => err);
      }),
    );
  }
}
