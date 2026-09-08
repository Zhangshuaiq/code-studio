import { context, propagation, trace, type Context } from '@opentelemetry/api';

export type TraceCarrier = Record<string, string>;

const setter = { set(carrier: TraceCarrier, key: string, value: string) { carrier[key] = value; } };
const getter = { get(carrier: TraceCarrier, key: string) { return carrier[key]; }, keys(carrier: TraceCarrier) { return Object.keys(carrier); } };

export function injectTraceContext(source: Context = context.active()): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(source, carrier, setter);
  return carrier;
}

export function extractTraceContext(carrier?: TraceCarrier): Context {
  return carrier ? propagation.extract(context.active(), carrier, getter) : context.active();
}

export function activeTraceIds() {
  const value = trace.getSpan(context.active())?.spanContext();
  return value && trace.isSpanContextValid(value) ? { traceId: value.traceId, spanId: value.spanId } : {};
}
