import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { getRequestContext } from '../observability/request-context';

@Injectable()
export class ApiMetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = Date.now();
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const record = (status: number) => {
      const method = request.method ?? 'UNKNOWN';
      const route = normalizeRoute(request.route?.path ?? request.originalUrl ?? request.url ?? 'unknown');
      const durationMs = Date.now() - startedAt;
      const context = getRequestContext();
      const entry = JSON.stringify({
        type: 'http_access',
        timestamp: new Date().toISOString(),
        requestId: context?.requestId,
        traceId: context?.traceId,
        method,
        route,
        statusCode: status,
        durationMs,
        userId: request.user?.id,
        clientIp: request.ip,
      });
      if (status >= 500) console.error(entry);
      else if (status >= 400) console.warn(entry);
      else console.log(entry);
    };
    return next.handle().pipe(tap({ next: () => record(response.statusCode), error: (error) => record(error?.status ?? error?.statusCode ?? 500) }));
  }
}

function normalizeRoute(value: string) {
  return value.split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}
