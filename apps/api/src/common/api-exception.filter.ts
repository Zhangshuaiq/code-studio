import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';

const STATUS_CODES: Record<number, string> = {
  400: 'INVALID_REQUEST',
  401: 'AUTH_REQUIRED',
  403: 'ACCESS_DENIED',
  404: 'RESOURCE_NOT_FOUND',
  409: 'RESOURCE_CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  502: 'UPSTREAM_UNAVAILABLE',
  503: 'SERVICE_UNAVAILABLE',
};

/** 为所有错误提供稳定 code/requestId，同时隐藏未知异常细节。 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const suppliedRequestId = request.header('x-request-id') || '';
    const requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const source = exception instanceof HttpException ? exception.getResponse() : null;
    const body = typeof source === 'object' && source !== null ? source as Record<string, unknown> : {};
    const publicBody = status >= 500 ? {} : body;
    const message = status >= 500
      ? '服务暂时不可用'
      : typeof source === 'string'
      ? source
      : body.message ?? '请求处理失败';
    if (!(exception instanceof HttpException) || status >= 500) {
      this.logger.error(
        `requestId=${requestId} ${request.method} ${request.originalUrl}: ${exception instanceof Error ? exception.stack || exception.message : String(exception)}`,
      );
    }
    response.setHeader('X-Request-Id', requestId);
    response.status(status).json({
      ...publicBody,
      statusCode: status,
      code: typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(body.code)
        ? body.code
        : STATUS_CODES[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'),
      message,
      requestId,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
    });
  }
}
