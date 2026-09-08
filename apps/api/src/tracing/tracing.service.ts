import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TraceSearchQueryDto } from './dto/trace-query.dto';
import { ProjectAccessService } from '../project-access/project-access.service';

@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);
  private readonly tempoUrl: string;
  constructor(config: ConfigService, private readonly access: ProjectAccessService) { this.tempoUrl = config.get<string>('TEMPO_URL', 'http://tempo:3200').replace(/\/$/, ''); }

  async health() {
    const started = Date.now();
    try { const response = await fetch(`${this.tempoUrl}/ready`, { signal: AbortSignal.timeout(2000) }); return { available: response.ok, latencyMs: Date.now() - started, ...(response.ok ? {} : { error: `HTTP ${response.status}` }) }; }
    catch (error) { return { available: false, latencyMs: Date.now() - started, error: (error as Error).message }; }
  }

  async search(userId: string, query: TraceSearchQueryDto) {
    await this.access.requireProject(userId, query.projectId, 'read');
    if (query.traceId) return { traces: [summarizeTrace(await this.trace(userId, query.projectId, query.traceId))] };
    const clauses: string[] = [];
    clauses.push(`resource.codegen.project.id = ${quote(query.projectId)}`);
    if (query.service) clauses.push(`resource.service.name = ${quote(query.service)}`);
    if (query.language) clauses.push(`resource.telemetry.sdk.language = ${quote(query.language)}`);
    if (query.environment) clauses.push(`resource.deployment.environment.name = ${quote(query.environment)}`);
    if (query.status === 'error') clauses.push('status = error');
    let traceQl = `{ ${clauses.join(' && ') || 'true'} }`;
    const minDuration = boundedNumber(query.minDurationMs, 0, 86_400_000, 0);
    if (minDuration) traceQl += ` | duration >= ${minDuration}ms`;
    const params = new URLSearchParams({ q: traceQl, limit: String(boundedNumber(query.limit, 1, 50, 30)) });
    const from = query.from ? validDate(query.from) : undefined;
    const to = query.to ? validDate(query.to) : undefined;
    if (from && to && (from >= to || to.getTime() - from.getTime() > 7 * 24 * 60 * 60_000)) throw new BadRequestException('Trace 查询时间范围必须递增且不超过 7 天');
    if (from) params.set('start', String(Math.floor(from.getTime() / 1000)));
    if (to) params.set('end', String(Math.floor(to.getTime() / 1000)));
    const data = record(await this.get(`/api/search?${params}`));
    const candidates = array(data.traces).slice(0, query.limit).map(traceSummary).filter((trace): trace is NonNullable<typeof trace> => !!trace);
    const traces: typeof candidates = [];
    for (const candidate of candidates) {
      const trace = await this.loadTrace(candidate.traceId).catch((error) => {
        if (error instanceof NotFoundException) return null;
        throw error;
      });
      if (trace && belongsToProject(trace, query.projectId)) traces.push(candidate);
    }
    return { traces, metrics: isRecord(data.metrics) ? data.metrics : null };
  }

  async trace(userId: string, projectIdValue: string, traceId: string) {
    await this.access.requireProject(userId, projectIdValue, 'read');
    const trace = await this.loadTrace(traceId);
    if (!belongsToProject(trace, projectIdValue)) throw new NotFoundException({ code: 'TRACE_NOT_FOUND_OR_INACCESSIBLE', message: 'Trace 不存在、缺少项目标识或无权访问' });
    return trace;
  }

  private async loadTrace(traceId: string) {
    if (!/^[a-fA-F0-9]{16,32}$/.test(traceId)) throw new BadRequestException('Trace ID 格式非法');
    const payload = await this.get(`/api/v2/traces/${traceId}`).catch(() => this.get(`/api/traces/${traceId}`));
    const spans = flattenTrace(payload);
    if (!spans.length) throw new NotFoundException('Trace 不存在或没有 Span');
    const traceStartNs = spans.reduce((min, span) => min < span.startNs ? min : span.startNs, spans[0].startNs);
    const traceEndNs = spans.reduce((max, span) => max > span.endNs ? max : span.endNs, spans[0].endNs);
    const children = new Map<string, typeof spans>();
    for (const span of spans) { const rows = children.get(span.parentSpanId) || []; rows.push(span); children.set(span.parentSpanId, rows); }
    const withTiming = spans.map((span) => ({ ...span, startOffsetMs: nsMs(span.startNs - traceStartNs), durationMs: nsMs(span.endNs - span.startNs), selfDurationMs: selfDuration(span, children.get(span.spanId) || []) })).sort((a, b) => a.startNs < b.startNs ? -1 : 1);
    return { traceId, startTimeUnixNano: traceStartNs.toString(), durationMs: nsMs(traceEndNs - traceStartNs), services: [...new Set(spans.map((span) => span.serviceName))], languages: [...new Set(spans.map((span) => span.language).filter(Boolean))], errorCount: spans.filter((span) => span.status === 'error').length, spans: withTiming.map(({ startNs, endNs, ...span }) => span) };
  }

  private async get(path: string): Promise<unknown> { try { const response = await fetch(`${this.tempoUrl}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }); if (response.status === 404) throw new NotFoundException('Trace 不存在'); if (!response.ok) throw new Error(`Tempo HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`); const declaredSize = Number(response.headers.get('content-length') || 0); if (declaredSize > 10 * 1024 * 1024) throw new Error('Tempo 响应超过 10 MiB'); const text = await response.text(); if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new Error('Tempo 响应超过 10 MiB'); return JSON.parse(text); } catch (error) { if (error instanceof NotFoundException) throw error; this.logger.warn(`Tempo 查询失败 path=${path}: ${(error as Error).message}`); throw new BadGatewayException('Trace 服务暂时不可用'); } }
}

interface RawSpan { spanId: string; parentSpanId: string; name: string; kind: unknown; serviceName: string; language: string; environment: string; projectId: string; status: string; statusMessage: string; attributes: Record<string, unknown>; events: unknown[]; startNs: bigint; endNs: bigint }
function flattenTrace(payload: unknown): RawSpan[] {
  const result: RawSpan[] = [];
  const root = record(payload); const trace = record(root.trace);
  const resourceSpans = array(root.resourceSpans ?? root.batches ?? trace.resourceSpans).slice(0, 1000);
  for (const rawBatch of resourceSpans) {
    const batch = record(rawBatch); const resourceNode = record(batch.resource);
    const resource = attributes(array(resourceNode.attributes ?? resourceNode.Attributes));
    for (const rawScope of array(batch.scopeSpans ?? batch.instrumentationLibrarySpans).slice(0, 1000)) for (const rawSpan of array(record(rawScope).spans).slice(0, 10_000 - result.length)) {
      const span = record(rawSpan); const status = record(span.status);
      const startNs = safeBigInt(span.startTimeUnixNano ?? span.startTimeUnixNanoString); const endNs = safeBigInt(span.endTimeUnixNano ?? span.endTimeUnixNanoString);
      const events = array(span.events).slice(0, 1000).map((rawEvent) => { const event = record(rawEvent); return { name: text(event.name), timeUnixNano: text(event.timeUnixNano), attributes: attributes(array(event.attributes)) }; });
      result.push({ spanId: text(span.spanId), parentSpanId: text(span.parentSpanId), name: text(span.name) || 'unnamed', kind: span.kind, serviceName: text(resource['service.name']) || 'unknown', language: text(resource['telemetry.sdk.language']), environment: text(resource['deployment.environment.name']), projectId: projectId(resource), status: status.code === 2 || status.code === 'STATUS_CODE_ERROR' ? 'error' : 'ok', statusMessage: text(status.message), attributes: attributes(array(span.attributes)), events, startNs, endNs });
      if (result.length >= 10_000) break;
    }
  }
  return result.filter((span) => span.spanId && span.endNs >= span.startNs);
}
function attributes(rows: unknown[]) { const entries: Array<[string, unknown]> = []; for (const raw of rows.slice(0, 1000)) { const row = record(raw); const key = text(row.key); if (key) entries.push([key, attributeValue(row.value, 0)]); } return Object.fromEntries(entries); }
function attributeValue(input: unknown, depth: number): unknown { if (depth > 5 || !isRecord(input)) return input; for (const key of ['stringValue','intValue','doubleValue','boolValue','bytesValue']) if (key in input) return input[key]; const arrayValue = record(input.arrayValue); if (input.arrayValue) return array(arrayValue.values).slice(0, 1000).map((item) => attributeValue(item, depth + 1)); const kvlistValue = record(input.kvlistValue); if (input.kvlistValue) return attributes(array(kvlistValue.values)); return {}; }
function traceSummary(input: unknown) { const trace = record(input); const traceId = text(trace.traceID); if (!/^[a-fA-F0-9]{16,32}$/.test(traceId)) return null; const spanSets = array(trace.spanSets); const spanSet = record(trace.spanSet); const matched = spanSets.reduce((sum, item) => sum + boundedNumber(record(item).matched, 0, 1_000_000, 0), 0) || boundedNumber(spanSet.matched, 0, 1_000_000, 0); return { traceId, rootServiceName: text(trace.rootServiceName) || 'unknown', rootTraceName: text(trace.rootTraceName) || 'trace', startTimeUnixNano: text(trace.startTimeUnixNano), durationMs: boundedNumber(trace.durationMs, 0, 86_400_000, 0), spanCount: matched, serviceStats: isRecord(trace.serviceStats) ? trace.serviceStats : {} }; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === 'string' ? value.slice(0, 10_000) : typeof value === 'number' || typeof value === 'bigint' ? String(value) : ''; }
function safeBigInt(value: unknown): bigint { const raw = text(value); return /^\d{1,30}$/.test(raw) ? BigInt(raw) : 0n; }
function selfDuration(parent: RawSpan, children: RawSpan[]) { const intervals = children.map((child) => [child.startNs < parent.startNs ? parent.startNs : child.startNs, child.endNs > parent.endNs ? parent.endNs : child.endNs] as [bigint,bigint]).filter(([start,end]) => end > start).sort((a,b) => a[0] < b[0] ? -1 : 1); let covered=0n; let start: bigint | undefined; let end: bigint | undefined; for (const row of intervals) { if (start === undefined) { [start,end]=row; continue; } if (row[0] <= end!) end = row[1] > end! ? row[1] : end; else { covered += end! - start; [start,end]=row; } } if (start !== undefined) covered += end! - start; return nsMs(parent.endNs-parent.startNs-covered); }
function nsMs(value: bigint) { return Number(value) / 1_000_000; }
function quote(value: string) { return `"${value.replace(/["\\\r\n]/g, '') .slice(0, 200)}"`; }
function boundedNumber(value: unknown, min: number, max: number, fallback: number) { const number=Number(value); return Number.isFinite(number) ? Math.min(max,Math.max(min,Math.floor(number))) : fallback; }
function validDate(value: string) { const date=new Date(value); if(!Number.isFinite(date.getTime()))throw new BadRequestException('时间格式非法'); return date; }
function projectId(resource: Record<string, unknown>) { const value = text(resource['codegen.project.id']); return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : ''; }
function belongsToProject(trace: { spans: Array<{ projectId: string }> }, expected: string) { const ids = new Set(trace.spans.map((span) => span.projectId)); return ids.size === 1 && ids.has(expected); }
function summarizeTrace(trace: { traceId: string; durationMs: number; errorCount: number; services: string[]; spans: Array<{ parentSpanId: string; serviceName: string; name: string }> }) { const root = trace.spans.find((span) => !span.parentSpanId); return { traceId: trace.traceId, rootServiceName: root?.serviceName || trace.services[0], rootTraceName: root?.name || 'trace', durationMs: trace.durationMs, spanCount: trace.spans.length, errorCount: trace.errorCount }; }
