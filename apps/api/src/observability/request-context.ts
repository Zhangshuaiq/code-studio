import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { context, trace } from '@opentelemetry/api';

export interface RequestContext {
  requestId: string;
  traceId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();
const safeRequestId = /^[a-zA-Z0-9._:-]{1,128}$/;
const traceparent = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;

export function requestContextMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const incomingRequestId = request.header('x-request-id')?.trim() ?? '';
  const requestId = safeRequestId.test(incomingRequestId)
    ? incomingRequestId
    : randomUUID();
  const incomingTrace = request.header('traceparent')?.trim() ?? '';
  const matchedTrace = traceparent.exec(incomingTrace);
  const activeSpan = trace.getSpan(context.active())?.spanContext();
  const traceId = activeSpan?.traceId
    ?? matchedTrace?.[1]?.toLowerCase()
    ?? randomBytes(16).toString('hex');
  const spanId = activeSpan?.spanId ?? randomBytes(8).toString('hex');

  response.setHeader('x-request-id', requestId);
  response.setHeader('traceparent', `00-${traceId}-${spanId}-01`);
  storage.run({ requestId, traceId }, next);
}

export function getRequestContext() {
  return storage.getStore();
}
