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
  if (depth > 4 || value == null) return value;
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
    const ip =
      (req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
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
      path: req.originalUrl || req.url,
      detail: meta.includeBody === false ? { bodyOmitted: true } : redact(req.body),
    };

    return next.handle().pipe(
      tap((body) => {
        this.audit.record({
          ...base,
          result: 'success',
          statusCode: res.statusCode,
          // 结果里若带资源名/id，补齐便于检索
          resourceName:
            (body?.name as string) ?? (body?.username as string) ?? null,
          resourceId: base.resourceId ?? (body?.id as string) ?? null,
        });
      }),
      catchError((err) => {
        this.audit.record({
          ...base,
          result: 'failure',
          statusCode: err?.status ?? err?.statusCode ?? 500,
          detail: { ...(base.detail as object), error: err?.message },
        });
        return throwError(() => err);
      }),
    );
  }
}
