import { Injectable } from '@nestjs/common';
import { TracingService } from '../tracing/tracing.service';

@Injectable()
export class TracingMcpFacade {
  constructor(
    private readonly tracing: TracingService,
  ) {}

  async get(userId: string, projectId: string, traceId: string) {
    const trace = await this.tracing.trace(userId, projectId, traceId);
    return {
      traceId: trace.traceId,
      startTimeUnixNano: trace.startTimeUnixNano,
      durationMs: trace.durationMs,
      services: trace.services,
      languages: trace.languages,
      errorCount: trace.errorCount,
      spans: trace.spans.slice(0, 1_000).map((span) => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        serviceName: span.serviceName,
        language: span.language,
        environment: span.environment,
        status: span.status,
        startOffsetMs: span.startOffsetMs,
        durationMs: span.durationMs,
        selfDurationMs: span.selfDurationMs,
      })),
      truncated: trace.spans.length > 1_000,
    };
  }
}
