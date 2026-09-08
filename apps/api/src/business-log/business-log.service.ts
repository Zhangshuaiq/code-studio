import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, createHmac, randomBytes, randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuthUser } from "../auth/jwt.strategy";
import {
  BusinessLogEntryDto,
  ApplicationMetricsDto,
  CreateMonitoringAlertRuleDto,
  CreateBusinessLogSourceDto,
  IngestBusinessLogsDto,
  SearchBusinessLogsDto,
  UpdateBusinessLogPolicyDto,
  UpdateMonitoringAlertRuleDto,
  UpdateAlertNotificationDto,
  UpdateBusinessLogSourceDto,
} from "./dto/business-log.dto";
import { OpenSearchService } from "./opensearch.service";
import { thresholdFiring } from "../monitoring/monitoring-calculations";
import { CryptoService } from "../crypto/crypto.service";
import { PageQueryDto, pageArgs, pageResult } from "../common/dto/page-query.dto";

export interface BusinessLogPolicy {
  retentionDays: number;
  defaultQueryRangeMinutes: number;
  maxQueryRangeHours: number;
  maxResultLines: number;
  queryTimeoutSeconds: number;
}

const POLICY_KEY = "business_logs.policy";
const ALERT_NOTIFICATION_KEY = "monitoring.alert_notification";
const DEFAULT_POLICY: BusinessLogPolicy = {
  retentionDays: 30,
  defaultQueryRangeMinutes: 15,
  maxQueryRangeHours: 168,
  maxResultLines: 1_000,
  queryTimeoutSeconds: 15,
};
const SECRET_KEY_RE =
  /pass(word)?|passphrase|token|privatekey|api[-_]?key|secret|authorization|cookie|credential/i;

interface SearchHit {
  _id: string;
  _index: string;
  _source: Record<string, unknown>;
  sort?: unknown[];
}

interface SearchResponse {
  took: number;
  timed_out: boolean;
  hits: {
    total: { value: number; relation: "eq" | "gte" } | number;
    hits: SearchHit[];
  };
  aggregations?: {
    levels?: { buckets: Array<{ key: string; doc_count: number }> };
    services?: { buckets: Array<{ key: string; doc_count: number }> };
    environments?: { buckets: Array<{ key: string; doc_count: number }> };
    timeline?: {
      buckets: Array<{ key_as_string: string; doc_count: number }>;
    };
  };
}

interface MetricValue { value?: number | null }
interface PercentileValues { values?: Record<string, number | null> }
interface CountBucket { key: string | number; doc_count: number }
interface ApplicationMetricsResponse {
  took?: number;
  timed_out?: boolean;
  hits?: { total?: { value?: number } | number };
  aggregations?: {
    successful?: { doc_count?: number };
    failed?: { doc_count?: number };
    latency?: MetricValue;
    latency_percentiles?: PercentileValues;
    status_codes?: { buckets?: CountBucket[] };
    environments?: { buckets?: Array<{ key: string; doc_count: number }> };
    services?: { buckets?: Array<{ key: string; doc_count: number }> };
    timeline?: { buckets?: Array<{ key_as_string?: string; doc_count?: number; successful?: { doc_count?: number }; failed?: { doc_count?: number }; p95?: PercentileValues }> };
    routes?: { buckets?: Array<{ key?: unknown[]; doc_count?: number; successful?: { doc_count?: number }; failed?: { doc_count?: number }; average_latency?: MetricValue; p95?: PercentileValues }> };
  };
}

interface CachedSource {
  id: string;
  projectId: string;
  name: string;
  environment: string;
  serviceName: string;
  format: string;
  status: string;
  tokenHash: string;
  project: { teamId: string | null };
}

@Injectable()
export class BusinessLogService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BusinessLogService.name);
  private retentionTimer?: NodeJS.Timeout;
  private alertTimer?: NodeJS.Timeout;
  private initialRetentionTimer?: NodeJS.Timeout;
  private initialAlertTimer?: NodeJS.Timeout;
  private evaluatingAlerts = false;
  private readonly heartbeatWrites = new Map<string, number>();
  private readonly sourceCache = new Map<
    string,
    { expiresAt: number; source: CachedSource }
  >();
  private policyCache?: { expiresAt: number; value: BusinessLogPolicy };

  constructor(
    private readonly prisma: PrismaService,
    private readonly openSearch: OpenSearchService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  async onApplicationBootstrap() {
    if (this.config.get<string>('PROCESS_ROLE', 'api') !== 'worker') return;
    await this.ensureDefaultPolicy();
    // 不阻塞 Worker 启动；OpenSearch 可能仍处于启动阶段。
    this.initialRetentionTimer = setTimeout(
      () => void this.runSingleton(771001, () => this.cleanupExpiredIndices()),
      20_000,
    );
    this.initialRetentionTimer.unref();
    this.retentionTimer = setInterval(
      () => void this.runSingleton(771001, () => this.cleanupExpiredIndices()),
      6 * 60 * 60 * 1_000,
    );
    this.retentionTimer.unref();
    this.initialAlertTimer = setTimeout(
      () => void this.runSingleton(771002, () => this.evaluateAlertRules()),
      30_000,
    );
    this.initialAlertTimer.unref();
    this.alertTimer = setInterval(() => void this.runSingleton(771002, () => this.evaluateAlertRules()), 60_000);
    this.alertTimer.unref();
  }

  onModuleDestroy() {
    if (this.initialRetentionTimer) clearTimeout(this.initialRetentionTimer);
    if (this.initialAlertTimer) clearTimeout(this.initialAlertTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.alertTimer) clearInterval(this.alertTimer);
  }

  /** 用 PostgreSQL 事务级 advisory lock 保证多 Worker 副本只执行一次周期任务。 */
  private async runSingleton(lockId: number, task: () => Promise<unknown>) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${lockId}) AS locked`;
        if (!rows[0]?.locked) return;
        await task();
      }, { timeout: 10 * 60_000 });
    } catch (error) {
      this.logger.warn(`周期任务执行失败 lock=${lockId}: ${(error as Error).message}`);
    }
  }

  async getPolicy(): Promise<BusinessLogPolicy> {
    if (this.policyCache && this.policyCache.expiresAt > Date.now()) {
      return this.policyCache.value;
    }
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: POLICY_KEY },
    });
    const value = this.normalizePolicy(row?.value);
    this.policyCache = { expiresAt: Date.now() + 30_000, value };
    return value;
  }

  async updatePolicy(userId: string, dto: UpdateBusinessLogPolicyDto) {
    const current = await this.getPolicy();
    const policy = this.normalizePolicy({ ...current, ...dto });
    await this.prisma.systemSetting.upsert({
      where: { key: POLICY_KEY },
      create: {
        key: POLICY_KEY,
        value: policy as unknown as Prisma.InputJsonValue,
        updatedById: userId,
      },
      update: {
        value: policy as unknown as Prisma.InputJsonValue,
        updatedById: userId,
      },
    });
    this.policyCache = { expiresAt: Date.now() + 30_000, value: policy };
    let cleanup: { deleted: string[]; cutoff: string } | { error: string };
    try {
      cleanup = await this.cleanupExpiredIndices(policy);
    } catch (error) {
      cleanup = { error: this.reason(error) };
    }
    return { ...policy, cleanup };
  }

  async listSources(user: AuthUser) {
    const projectIds = await this.accessibleProjectIds(user);
    return this.prisma.businessLogSource.findMany({
      where: this.isAdmin(user) ? {} : { projectId: { in: projectIds } },
      select: {
        id: true,
        projectId: true,
        name: true,
        environment: true,
        serviceName: true,
        format: true,
        status: true,
        tokenPrefix: true,
        lastIngestedAt: true,
        createdAt: true,
        updatedAt: true,
        project: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async createSource(user: AuthUser, dto: CreateBusinessLogSourceDto) {
    await this.assertProjectAccess(user, dto.projectId);
    const token = this.generateToken();
    const source = await this.prisma.businessLogSource.create({
      data: {
        projectId: dto.projectId,
        name: dto.name.trim(),
        environment: dto.environment.trim(),
        serviceName: dto.serviceName.trim(),
        format: dto.format ?? "json",
        tokenHash: this.tokenHash(token),
        tokenPrefix: token.slice(0, 12),
      },
      select: {
        id: true,
        projectId: true,
        name: true,
        environment: true,
        serviceName: true,
        format: true,
        status: true,
        tokenPrefix: true,
        createdAt: true,
      },
    });
    return { ...source, token };
  }

  async updateSource(
    user: AuthUser,
    id: string,
    dto: UpdateBusinessLogSourceDto,
  ) {
    const source = await this.getAccessibleSource(user, id);
    this.sourceCache.delete(source.tokenHash);
    return this.prisma.businessLogSource.update({
      where: { id: source.id },
      data: {
        name: dto.name?.trim(),
        environment: dto.environment?.trim(),
        serviceName: dto.serviceName?.trim(),
        format: dto.format,
        status: dto.status,
      },
      select: {
        id: true,
        projectId: true,
        name: true,
        environment: true,
        serviceName: true,
        format: true,
        status: true,
        tokenPrefix: true,
        lastIngestedAt: true,
        updatedAt: true,
      },
    });
  }

  async rotateSourceToken(user: AuthUser, id: string) {
    const source = await this.getAccessibleSource(user, id);
    this.sourceCache.delete(source.tokenHash);
    const token = this.generateToken();
    await this.prisma.businessLogSource.update({
      where: { id: source.id },
      data: {
        tokenHash: this.tokenHash(token),
        tokenPrefix: token.slice(0, 12),
      },
    });
    return { id: source.id, token, tokenPrefix: token.slice(0, 12) };
  }

  async deleteSource(user: AuthUser, id: string) {
    const source = await this.getAccessibleSource(user, id);
    this.sourceCache.delete(source.tokenHash);
    await this.prisma.businessLogSource.delete({ where: { id: source.id } });
    // 历史日志按平台保留策略继续存在，避免删除接入配置时误删审计证据。
    return { ok: true };
  }

  async ingest(token: string | undefined, dto: IngestBusinessLogsDto) {
    if (!token) throw new UnauthorizedException("缺少日志源 Token");
    const hash = this.tokenHash(token);
    const cached = this.sourceCache.get(hash);
    let source: CachedSource | null =
      cached && cached.expiresAt > Date.now() ? cached.source : null;
    if (!source) {
      source = await this.prisma.businessLogSource.findUnique({
        where: { tokenHash: hash },
        include: {
          project: { select: { teamId: true } },
        },
      });
      if (source) {
        this.sourceCache.set(hash, {
          expiresAt: Date.now() + 60_000,
          source,
        });
      }
    }
    if (!source || source.status !== "active") {
      throw new UnauthorizedException("日志源 Token 无效或已停用");
    }

    // OpenSearch 可能刚启动，写入前幂等确保模板存在。
    await this.openSearch.ensureIndexTemplate();
    const policy = await this.getPolicy();
    const ingestedAt = new Date().toISOString();
    const entries = dto.logs.map((entry) => {
      const parsed =
        source.format === "log4j" ? this.parseLog4j(entry.message) : undefined;
      const timestamp = entry.timestamp
        ? new Date(entry.timestamp).toISOString()
        : parsed?.timestamp || ingestedAt;
      const eventTime = new Date(timestamp).getTime();
      const oldest = Date.now() - policy.retentionDays * 24 * 60 * 60 * 1_000;
      if (eventTime < oldest || eventTime > Date.now() + 5 * 60_000) {
        throw new BadRequestException(`日志时间 ${timestamp} 超出允许写入范围`);
      }
      const attributes = this.redactObject(entry.attributes ?? {});
      const http = this.httpFields(attributes);
      return {
        index: this.indexForTimestamp(timestamp),
        routing: source.projectId,
        document: {
          "@timestamp": timestamp,
          ingested_at: ingestedAt,
          event_id: randomUUID(),
          project_id: source.projectId,
          team_id: source.project.teamId,
          source_id: source.id,
          source_name: source.name,
          environment: source.environment,
          service_name: source.serviceName,
          level: (entry.level || parsed?.level || "INFO").trim().toUpperCase(),
          logger: entry.logger?.trim() || parsed?.logger || null,
          thread: entry.thread?.trim() || parsed?.thread || null,
          trace_id: entry.traceId?.trim() || null,
          span_id: entry.spanId?.trim() || null,
          ...http,
          message: this.redactText(parsed?.message || entry.message),
          stack_trace:
            entry.stackTrace || parsed?.stackTrace
              ? this.redactText(entry.stackTrace || parsed?.stackTrace || "")
              : null,
          attributes,
          attributes_text: JSON.stringify(attributes).slice(0, 32_000),
        },
      };
    });
    const result = await this.openSearch.bulk(entries);
    if (result.accepted > 0) this.touchSource(source.id);
    return result;
  }

  async search(user: AuthUser, dto: SearchBusinessLogsDto) {
    await this.assertProjectAccess(user, dto.projectId);
    const policy = await this.getPolicy();
    const from = new Date(dto.from);
    const to = new Date(dto.to);
    if (from >= to) throw new BadRequestException("开始时间必须早于结束时间");
    const rangeMs = to.getTime() - from.getTime();
    if (rangeMs > policy.maxQueryRangeHours * 60 * 60 * 1_000) {
      throw new BadRequestException(
        `单次查询最多 ${policy.maxQueryRangeHours} 小时，请缩小时间范围`,
      );
    }
    if (to.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException("结束时间不能超过当前时间 5 分钟");
    }

    const limit = Math.min(dto.limit ?? 200, policy.maxResultLines);
    const filters: unknown[] = [
      { term: { project_id: dto.projectId } },
      {
        range: {
          "@timestamp": { gte: from.toISOString(), lte: to.toISOString() },
        },
      },
    ];
    if (dto.environment)
      filters.push({ term: { environment: dto.environment } });
    if (dto.serviceName)
      filters.push({ term: { service_name: dto.serviceName } });
    if (dto.levels?.length)
      filters.push({
        terms: { level: dto.levels.map((level) => level.toUpperCase()) },
      });
    if (dto.traceId) filters.push({ term: { trace_id: dto.traceId } });

    const must: unknown[] = [];
    if (dto.query?.trim()) {
      must.push({
        multi_match: {
          query: dto.query.trim(),
          fields: ["message^3", "stack_trace", "attributes_text", "logger"],
          operator: "and",
          type: "best_fields",
        },
      });
    }

    const interval =
      rangeMs <= 60 * 60_000
        ? "1m"
        : rangeMs <= 12 * 60 * 60_000
          ? "5m"
          : rangeMs <= 48 * 60 * 60_000
            ? "30m"
            : "1h";
    const body: Record<string, unknown> = {
      size: limit,
      timeout: `${policy.queryTimeoutSeconds}s`,
      track_total_hits: 10_000,
      query: { bool: { filter: filters, must } },
      sort: [
        { "@timestamp": { order: "desc" } },
        { event_id: { order: "desc" } },
      ],
      aggs: {
        levels: { terms: { field: "level", size: 12 } },
        services: { terms: { field: "service_name", size: 50 } },
        environments: { terms: { field: "environment", size: 30 } },
        timeline: {
          date_histogram: {
            field: "@timestamp",
            fixed_interval: interval,
            min_doc_count: 0,
            extended_bounds: {
              min: from.toISOString(),
              max: to.toISOString(),
            },
          },
        },
      },
    };
    if (dto.cursor) body.search_after = this.decodeCursor(dto.cursor);

    const response = await this.openSearch.search<SearchResponse>(
      this.indicesForRange(from, to),
      body,
      dto.projectId,
    );
    const hits = response.hits?.hits ?? [];
    const total = response.hits?.total;
    const totalValue = typeof total === "number" ? total : (total?.value ?? 0);
    const totalRelation =
      typeof total === "number" ? "eq" : (total?.relation ?? "eq");
    return {
      items: hits.map((hit) => ({
        id: hit._id,
        index: hit._index,
        ...hit._source,
      })),
      total: totalValue,
      totalRelation,
      tookMs: response.took ?? 0,
      timedOut: response.timed_out ?? false,
      nextCursor:
        hits.length === limit && hits[hits.length - 1]?.sort
          ? this.encodeCursor(hits[hits.length - 1].sort!)
          : null,
      facets: {
        levels: this.buckets(response.aggregations?.levels?.buckets),
        services: this.buckets(response.aggregations?.services?.buckets),
        environments: this.buckets(
          response.aggregations?.environments?.buckets,
        ),
      },
      timeline: (response.aggregations?.timeline?.buckets ?? []).map((b) => ({
        time: b.key_as_string,
        count: b.doc_count,
      })),
    };
  }

  async applicationMetrics(user: AuthUser, dto: ApplicationMetricsDto) {
    await this.assertProjectAccess(user, dto.projectId);
    const policy = await this.getPolicy();
    const from = new Date(dto.from);
    const to = new Date(dto.to);
    if (from >= to) throw new BadRequestException("开始时间必须早于结束时间");
    const rangeMs = to.getTime() - from.getTime();
    if (rangeMs > policy.maxQueryRangeHours * 60 * 60 * 1_000) {
      throw new BadRequestException(
        `单次查询最多 ${policy.maxQueryRangeHours} 小时，请缩小时间范围`,
      );
    }
    const filters: unknown[] = [
      { term: { project_id: dto.projectId } },
      { exists: { field: "http_route" } },
      { range: { "@timestamp": { gte: dto.from, lte: dto.to } } },
    ];
    if (dto.environment) filters.push({ term: { environment: dto.environment } });
    if (dto.serviceName) filters.push({ term: { service_name: dto.serviceName } });
    const interval =
      rangeMs <= 60 * 60_000 ? "1m" : rangeMs <= 12 * 60 * 60_000 ? "5m" : rangeMs <= 48 * 60 * 60_000 ? "30m" : "1h";
    const response = await this.openSearch.search<ApplicationMetricsResponse>(
      this.indicesForRange(from, to),
      {
        size: 0,
        track_total_hits: true,
        timeout: `${policy.queryTimeoutSeconds}s`,
        query: { bool: { filter: filters } },
        aggs: {
          successful: { filter: { term: { success: true } } },
          failed: { filter: { term: { success: false } } },
          latency: { avg: { field: "duration_ms" } },
          latency_percentiles: {
            percentiles: { field: "duration_ms", percents: [50, 90, 95, 99] },
          },
          status_codes: { terms: { field: "status_code", size: 20 } },
          environments: { terms: { field: "environment", size: 30 } },
          services: { terms: { field: "service_name", size: 50 } },
          timeline: {
            date_histogram: {
              field: "@timestamp",
              fixed_interval: interval,
              min_doc_count: 0,
              extended_bounds: { min: dto.from, max: dto.to },
            },
            aggs: {
              successful: { filter: { term: { success: true } } },
              failed: { filter: { term: { success: false } } },
              p95: { percentiles: { field: "duration_ms", percents: [95] } },
            },
          },
          routes: {
            multi_terms: {
              terms: [{ field: "http_method" }, { field: "http_route" }],
              size: 100,
              order: { _count: "desc" },
            },
            aggs: {
              successful: { filter: { term: { success: true } } },
              failed: { filter: { term: { success: false } } },
              average_latency: { avg: { field: "duration_ms" } },
              p95: { percentiles: { field: "duration_ms", percents: [95] } },
            },
          },
        },
      },
      dto.projectId,
    );
    const aggs = response.aggregations ?? {};
    const total = Number(response.hits?.total?.value ?? response.hits?.total ?? 0);
    const successful = Number(aggs.successful?.doc_count ?? 0);
    const failed = Number(aggs.failed?.doc_count ?? 0);
    const rate = (ok: number, count: number) => count ? (ok / count) * 100 : 0;
    const percentile = (node: PercentileValues | undefined, key: string) => {
      const value = node?.values?.[key];
      return Number.isFinite(value) ? Number(value) : 0;
    };
    return {
      total,
      successful,
      failed,
      successRate: rate(successful, total),
      averageLatencyMs: Number(aggs.latency?.value ?? 0),
      latency: {
        p50: percentile(aggs.latency_percentiles, "50.0"),
        p90: percentile(aggs.latency_percentiles, "90.0"),
        p95: percentile(aggs.latency_percentiles, "95.0"),
        p99: percentile(aggs.latency_percentiles, "99.0"),
      },
      statusCodes: (aggs.status_codes?.buckets ?? []).map((b) => ({ code: Number(b.key), count: b.doc_count })),
      environments: this.buckets(aggs.environments?.buckets),
      services: this.buckets(aggs.services?.buckets),
      timeline: (aggs.timeline?.buckets ?? []).map((b) => ({
        time: b.key_as_string || '',
        total: b.doc_count ?? 0,
        successful: b.successful?.doc_count ?? 0,
        failed: b.failed?.doc_count ?? 0,
        successRate: rate(b.successful?.doc_count ?? 0, b.doc_count ?? 0),
        p95Ms: percentile(b.p95, "95.0"),
      })),
      routes: (aggs.routes?.buckets ?? []).map((b) => ({
        method: typeof b.key?.[0] === 'string' ? b.key[0] : "UNKNOWN",
        route: typeof b.key?.[1] === 'string' ? b.key[1] : "unknown",
        total: b.doc_count ?? 0,
        successful: b.successful?.doc_count ?? 0,
        failed: b.failed?.doc_count ?? 0,
        successRate: rate(b.successful?.doc_count ?? 0, b.doc_count ?? 0),
        averageLatencyMs: Number(b.average_latency?.value ?? 0),
        p95Ms: percentile(b.p95, "95.0"),
      })),
      tookMs: response.took ?? 0,
      timedOut: response.timed_out ?? false,
    };
  }

  async platformMetrics(user: AuthUser, dto: ApplicationMetricsDto) {
    await this.assertProjectAccess(user, dto.projectId);
    const from = new Date(dto.from);
    const to = new Date(dto.to);
    if (from >= to) throw new BadRequestException("开始时间必须早于结束时间");
    const createdAt = { gte: from, lte: to };
    const [tasks, deployments, previews, sandboxes] = await Promise.all([
      this.prisma.task.groupBy({
        by: ["status"],
        where: { session: { projectId: dto.projectId }, createdAt },
        _count: { _all: true },
      }),
      this.prisma.deploymentRecord.groupBy({
        by: ["status"],
        where: { projectId: dto.projectId, createdAt },
        _count: { _all: true },
      }),
      this.prisma.previewInstance.groupBy({
        by: ["status"],
        where: { session: { projectId: dto.projectId } },
        _count: { _all: true },
      }),
      this.prisma.sandboxInstance.groupBy({
        by: ["status"],
        where: { session: { projectId: dto.projectId } },
        _count: { _all: true },
      }),
    ]);
    const summarize = (
      rows: Array<{ status: string; _count: { _all: number } }>,
      successStatuses: string[],
      failureStatuses: string[],
    ) => {
      const statuses = Object.fromEntries(
        rows.map((row) => [row.status, row._count._all]),
      );
      const total = rows.reduce((sum, row) => sum + row._count._all, 0);
      const successful = successStatuses.reduce(
        (sum, status) => sum + (statuses[status] ?? 0),
        0,
      );
      const failed = failureStatuses.reduce(
        (sum, status) => sum + (statuses[status] ?? 0),
        0,
      );
      const completed = successful + failed;
      return {
        total,
        successful,
        failed,
        successRate: completed ? (successful / completed) * 100 : 0,
        statuses,
      };
    };
    return {
      generation: summarize(tasks, ["succeeded"], ["failed", "cancelled", "timed_out"]),
      deployment: summarize(deployments, ["running", "succeeded"], ["failed"]),
      preview: summarize(previews, ["ready", "running"], ["failed"]),
      sandbox: summarize(sandboxes, ["running"], ["failed", "stopped"]),
      from: dto.from,
      to: dto.to,
    };
  }

  async listAlertRules(user: AuthUser, projectId: string) {
    await this.assertProjectAccess(user, projectId);
    return this.prisma.monitoringAlertRule.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }

  async createAlertRule(user: AuthUser, dto: CreateMonitoringAlertRuleDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.prisma.monitoringAlertRule.create({
      data: {
        ...dto,
        name: dto.name.trim(),
        environment: dto.environment?.trim() || null,
        serviceName: dto.serviceName?.trim() || null,
      },
    });
  }

  async updateAlertRule(
    user: AuthUser,
    id: string,
    dto: UpdateMonitoringAlertRuleDto,
  ) {
    const rule = await this.prisma.monitoringAlertRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException("告警规则不存在");
    await this.assertProjectAccess(user, rule.projectId);
    return this.prisma.monitoringAlertRule.update({
      where: { id },
      data: {
        ...dto,
        name: dto.name?.trim(),
        environment: dto.environment === undefined ? undefined : dto.environment.trim() || null,
        serviceName: dto.serviceName === undefined ? undefined : dto.serviceName.trim() || null,
      },
    });
  }

  async deleteAlertRule(user: AuthUser, id: string) {
    const rule = await this.prisma.monitoringAlertRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException("告警规则不存在");
    await this.assertProjectAccess(user, rule.projectId);
    await this.prisma.monitoringAlertRule.delete({ where: { id } });
    return { ok: true };
  }

  async listAlertEvents(user: AuthUser, projectId: string, query: PageQueryDto) {
    await this.assertProjectAccess(user, projectId);
    const where = { projectId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.monitoringAlertEvent.findMany({
      where,
      ...pageArgs(query),
      include: { rule: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
      this.prisma.monitoringAlertEvent.count({ where }),
    ]);
    return pageResult(items, total, query);
  }

  async getAlertNotificationConfig() {
    const config = await this.resolveAlertNotification();
    return { enabled: config.enabled, url: config.url, configured: !!config.url, secretConfigured: !!config.secret, source: config.source };
  }

  async updateAlertNotificationConfig(userId: string, dto: UpdateAlertNotificationDto) {
    const current = await this.resolveAlertNotification();
    const url = dto.url?.trim() || current.url;
    if (dto.enabled && !url) throw new BadRequestException("启用 Webhook 前必须填写 URL");
    if (url) this.assertWebhookUrl(url);
    const secret = dto.clearSecret ? "" : dto.secret === undefined ? current.secret : dto.secret;
    const value = {
      enabled: dto.enabled,
      encryptedUrl: url ? this.crypto.encrypt(url) : null,
      encryptedSecret: secret ? this.crypto.encrypt(secret) : null,
    };
    await this.prisma.systemSetting.upsert({
      where: { key: ALERT_NOTIFICATION_KEY },
      create: { key: ALERT_NOTIFICATION_KEY, value, updatedById: userId },
      update: { value, updatedById: userId },
    });
    return { enabled: dto.enabled, url, configured: !!url, secretConfigured: !!secret, source: "database" };
  }

  async testAlertNotification() {
    const config = await this.resolveAlertNotification();
    if (!config.enabled || !config.url) throw new BadRequestException("Webhook 尚未启用或未配置");
    await this.sendWebhook(config.url, config.secret, {
      type: "monitoring.alert.test",
      message: "Code Studio 告警通知测试",
      occurredAt: new Date().toISOString(),
    });
    return { ok: true };
  }

  private async evaluateAlertRules() {
    if (this.evaluatingAlerts) return;
    this.evaluatingAlerts = true;
    try {
      const rules = await this.prisma.monitoringAlertRule.findMany({
        where: { enabled: true },
      });
      for (const rule of rules) {
        try {
          const to = new Date();
          const metrics = await this.applicationMetrics(
            { id: "system", username: "system", email: null, roles: ["admin"], permissions: [] },
            {
              projectId: rule.projectId,
              from: new Date(to.getTime() - rule.windowMinutes * 60_000).toISOString(),
              to: to.toISOString(),
              environment: rule.environment ?? undefined,
              serviceName: rule.serviceName ?? undefined,
            },
          );
          const value = rule.metric === "success_rate"
            ? metrics.successRate
            : rule.metric === "error_rate"
              ? 100 - metrics.successRate
              : metrics.latency.p95;
          const firing = thresholdFiring(rule.operator, value, rule.threshold);
          const coolingDown = rule.lastTriggeredAt &&
            Date.now() - rule.lastTriggeredAt.getTime() < rule.cooldownMinutes * 60_000;
          if (metrics.total === 0) continue;
          if (!firing && rule.state === "firing") {
            const [event] = await this.prisma.$transaction([
              this.prisma.monitoringAlertEvent.create({
                data: {
                  projectId: rule.projectId,
                  ruleId: rule.id,
                  metric: rule.metric,
                  value,
                  threshold: rule.threshold,
                  status: "resolved",
                  message: `${rule.name} 已恢复: ${rule.metric} 当前值 ${value.toFixed(2)}`,
                },
              }),
              this.prisma.monitoringAlertRule.update({
                where: { id: rule.id },
                data: { state: "ok", lastValue: value, lastEvaluatedAt: to },
              }),
            ]);
            void this.deliverAlert(event.id, {
              status: "resolved", eventId: event.id, projectId: rule.projectId,
              ruleId: rule.id, ruleName: rule.name, metric: rule.metric,
              value, threshold: rule.threshold, operator: rule.operator,
              message: event.message, occurredAt: event.createdAt.toISOString(),
            });
            continue;
          }
          if (!firing) {
            await this.prisma.monitoringAlertRule.update({
              where: { id: rule.id },
              data: { state: "ok", lastValue: value, lastEvaluatedAt: to },
            });
            continue;
          }
          if (coolingDown && rule.state === "firing") {
            await this.prisma.monitoringAlertRule.update({
              where: { id: rule.id },
              data: { lastValue: value, lastEvaluatedAt: to },
            });
            continue;
          }
          const [event] = await this.prisma.$transaction([
            this.prisma.monitoringAlertEvent.create({
              data: {
                projectId: rule.projectId,
                ruleId: rule.id,
                metric: rule.metric,
                value,
                threshold: rule.threshold,
                message: `${rule.name}: ${rule.metric} 当前值 ${value.toFixed(2)}，阈值 ${rule.operator} ${rule.threshold}`,
              },
            }),
            this.prisma.monitoringAlertRule.update({
              where: { id: rule.id },
              data: { lastTriggeredAt: new Date(), state: "firing", lastValue: value, lastEvaluatedAt: to },
            }),
          ]);
          void this.deliverAlert(event.id, {
            eventId: event.id,
            projectId: rule.projectId,
            ruleId: rule.id,
            ruleName: rule.name,
            metric: rule.metric,
            value,
            threshold: rule.threshold,
            operator: rule.operator,
            message: event.message,
            status: "firing",
            occurredAt: event.createdAt.toISOString(),
          });
        } catch (error) {
          this.logger.warn(`告警规则评估失败 rule=${rule.id}: ${this.reason(error)}`);
        }
      }
    } finally {
      this.evaluatingAlerts = false;
    }
  }

  private async deliverAlert(eventId: string, payload: Record<string, unknown>) {
    const notification = await this.resolveAlertNotification();
    if (!notification.enabled || !notification.url) {
      await this.prisma.monitoringAlertEvent.update({
        where: { id: eventId },
        data: { notificationStatus: "in_app" },
      });
      return;
    }
    try {
      await this.sendWebhook(notification.url, notification.secret, { type: `monitoring.alert.${payload.status ?? "firing"}`, ...payload });
      await this.prisma.monitoringAlertEvent.update({
        where: { id: eventId },
        data: { notificationStatus: "sent", notifiedAt: new Date(), notificationError: null },
      });
    } catch (error) {
      const reason = this.reason(error).slice(0, 500);
      this.logger.warn(`告警 Webhook 发送失败 event=${eventId}: ${reason}`);
      await this.prisma.monitoringAlertEvent.update({
        where: { id: eventId },
        data: { notificationStatus: "failed", notificationError: reason },
      }).catch(() => undefined);
    }
  }

  private async resolveAlertNotification() {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: ALERT_NOTIFICATION_KEY } });
    if (row) {
      const value = row.value as { enabled?: boolean; encryptedUrl?: string | null; encryptedSecret?: string | null };
      return {
        enabled: value.enabled === true,
        url: value.encryptedUrl ? this.crypto.decrypt(value.encryptedUrl) : "",
        secret: value.encryptedSecret ? this.crypto.decrypt(value.encryptedSecret) : "",
        source: "database",
      };
    }
    const url = this.config.get<string>("MONITORING_ALERT_WEBHOOK_URL")?.trim() ?? "";
    return { enabled: !!url, url, secret: this.config.get<string>("MONITORING_ALERT_WEBHOOK_SECRET") ?? "", source: "environment" };
  }

  private assertWebhookUrl(url: string) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new BadRequestException('Webhook 仅支持 HTTP/HTTPS');
  }

  private async sendWebhook(url: string, secret: string, payload: Record<string, unknown>) {
    this.assertWebhookUrl(url);
    const body = JSON.stringify(payload);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-code-studio-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` } : {}) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Webhook 返回 HTTP ${response.status}`);
  }

  async getHealth() {
    try {
      const [health, indices] = await Promise.all([
        this.openSearch.health(),
        this.openSearch.listLogIndices(),
      ]);
      return {
        ...health,
        indexCount: indices.length,
        documents: indices.reduce(
          (sum, item) => sum + Number(item.docsCount || 0),
          0,
        ),
      };
    } catch (error) {
      return { available: false, error: this.reason(error) };
    }
  }

  async cleanupExpiredIndices(policy?: BusinessLogPolicy) {
    const activePolicy = policy ?? (await this.getPolicy());
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - activePolicy.retentionDays);
    const cutoff = cutoffDate.toISOString().slice(0, 10).replace(/-/g, ".");
    const indices = await this.openSearch.listLogIndices();
    const expired = indices
      .map((item) => item.index)
      .filter((index) => {
        const match = /^business-logs-(\d{4}\.\d{2}\.\d{2})$/.exec(index);
        return !!match && match[1] < cutoff;
      });
    const deleted: string[] = [];
    for (const index of expired) {
      try {
        await this.openSearch.deleteIndex(index);
        deleted.push(index);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("404"))) {
          throw error;
        }
      }
    }
    if (deleted.length) {
      this.logger.log(`已清理过期业务日志索引: ${deleted.join(", ")}`);
    }
    return { deleted, cutoff };
  }

  private async ensureDefaultPolicy() {
    await this.prisma.systemSetting.upsert({
      where: { key: POLICY_KEY },
      create: {
        key: POLICY_KEY,
        value: DEFAULT_POLICY as unknown as Prisma.InputJsonValue,
      },
      update: {},
    });
  }

  private normalizePolicy(value: unknown): BusinessLogPolicy {
    const input = (value || {}) as Partial<BusinessLogPolicy>;
    return {
      retentionDays: this.number(input.retentionDays, 1, 3_650, 30),
      defaultQueryRangeMinutes: this.number(
        input.defaultQueryRangeMinutes,
        5,
        1_440,
        15,
      ),
      maxQueryRangeHours: this.number(input.maxQueryRangeHours, 1, 720, 168),
      maxResultLines: this.number(input.maxResultLines, 100, 10_000, 1_000),
      queryTimeoutSeconds: this.number(input.queryTimeoutSeconds, 3, 120, 15),
    };
  }

  private number(value: unknown, min: number, max: number, fallback: number) {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  }

  private async accessibleProjectIds(user: AuthUser): Promise<string[]> {
    const projects = await this.prisma.project.findMany({
      where: this.isAdmin(user)
        ? {}
        : {
            OR: [
              { userId: user.id },
              { members: { some: { userId: user.id } } },
            ],
          },
      select: { id: true },
    });
    return projects.map((project) => project.id);
  }

  private async assertProjectAccess(user: AuthUser, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ...(this.isAdmin(user)
          ? {}
          : {
              OR: [
                { userId: user.id },
                { members: { some: { userId: user.id } } },
              ],
            }),
      },
      select: { id: true },
    });
    if (!project) throw new ForbiddenException("无权访问该项目日志");
  }

  private async getAccessibleSource(user: AuthUser, id: string) {
    const projectIds = await this.accessibleProjectIds(user);
    const source = await this.prisma.businessLogSource.findFirst({
      where: {
        id,
        ...(this.isAdmin(user) ? {} : { projectId: { in: projectIds } }),
      },
    });
    if (!source) throw new NotFoundException("日志源不存在或无权访问");
    return source;
  }

  private isAdmin(user: AuthUser) {
    return user.roles.includes("admin");
  }

  private generateToken() {
    return `bls_${randomBytes(32).toString("base64url")}`;
  }

  private tokenHash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  private touchSource(sourceId: string) {
    const now = Date.now();
    if (now - (this.heartbeatWrites.get(sourceId) ?? 0) < 60_000) return;
    this.heartbeatWrites.set(sourceId, now);
    this.prisma.businessLogSource
      .update({
        where: { id: sourceId },
        data: { lastIngestedAt: new Date(now) },
      })
      .catch((error) =>
        this.logger.warn(`更新日志源心跳失败: ${this.reason(error)}`),
      );
  }

  private indexForTimestamp(timestamp: string) {
    return `business-logs-${timestamp.slice(0, 10).replace(/-/g, ".")}`;
  }

  private indicesForRange(from: Date, to: Date) {
    const indices: string[] = [];
    const current = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
    );
    const last = new Date(
      Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()),
    );
    while (current <= last) {
      indices.push(this.indexForTimestamp(current.toISOString()));
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return indices;
  }

  private encodeCursor(sort: unknown[]) {
    return Buffer.from(JSON.stringify(sort)).toString("base64url");
  }

  private decodeCursor(cursor: string): unknown[] {
    try {
      const decoded = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
      if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error();
      return decoded;
    } catch {
      throw new BadRequestException("分页游标无效，请重新查询");
    }
  }

  private buckets(
    values: Array<{ key: string; doc_count: number }> | undefined,
  ) {
    return (values ?? []).map((item) => ({
      value: item.key,
      count: item.doc_count,
    }));
  }

  private httpFields(attributes: Record<string, unknown>) {
    const read = (...keys: string[]) => {
      for (const key of keys) {
        if (attributes[key] !== undefined) return attributes[key];
        const nested = key.split(".").reduce<unknown>((value, part) => {
          return value && typeof value === "object"
            ? (value as Record<string, unknown>)[part]
            : undefined;
        }, attributes);
        if (nested !== undefined) return nested;
      }
      return undefined;
    };
    const method = String(read("http.method", "http_method", "method") ?? "")
      .trim()
      .toUpperCase();
    const rawRoute = String(
      read("http.route", "http_route", "route", "http.path", "path") ?? "",
    ).trim();
    if (!method || !rawRoute) return {};
    const route = this.normalizeRoute(rawRoute);
    const status = Number(
      read("http.status_code", "status_code", "statusCode", "status"),
    );
    const duration = Number(
      read("duration_ms", "durationMs", "http.duration_ms", "latency_ms"),
    );
    const businessCode = read("business.code", "business_code", "businessCode");
    const explicitSuccess = read("success", "business.success");
    const success =
      typeof explicitSuccess === "boolean"
        ? explicitSuccess
        : Number.isFinite(status)
          ? status >= 200 && status < 400 &&
            (businessCode === undefined || [0, "0", "OK", "SUCCESS"].includes(businessCode as never))
          : undefined;
    return {
      event_type: "http_request",
      http_method: method.slice(0, 16),
      http_route: route.slice(0, 512),
      status_code: Number.isInteger(status) ? status : null,
      business_code:
        businessCode === undefined ? null : String(businessCode).slice(0, 128),
      success: success ?? null,
      duration_ms: Number.isFinite(duration) && duration >= 0 ? duration : null,
      deployment_id:
        String(read("deployment.id", "deployment_id", "deploymentId") ?? "").slice(0, 128) || null,
      version:
        String(read("service.version", "version", "release") ?? "").slice(0, 256) || null,
    };
  }

  private normalizeRoute(value: string) {
    let path = value;
    try {
      path = new URL(value, "http://local").pathname;
    } catch {
      path = value.split("?")[0];
    }
    return (
      path
        .replace(/\/[0-9]+(?=\/|$)/g, "/:id")
        .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:id")
        .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/:id") || "/"
    );
  }

  private redactText(value: string) {
    return value.replace(
      /((?:password|token|secret|authorization|cookie|api[-_]?key)\s*[:=]\s*)([^\s,;]+)/gi,
      "$1***",
    );
  }

  /**
   * 兼容常见 Log4j/Log4j2 PatternLayout：
   * 2026-08-18 10:20:30.123 [http-nio-1] ERROR com.acme.Order - message
   * 2026-08-18 10:20:30,123 ERROR [http-nio-1] com.acme.Order - message
   * PatternLayout 可自定义；无法识别时保留整行原文，不丢日志。
   */
  private parseLog4j(value: string):
    | {
        timestamp?: string;
        level: string;
        thread?: string;
        logger?: string;
        message: string;
        stackTrace?: string;
      }
    | undefined {
    const [head, ...tail] = value.split(/\r?\n/);
    const patterns = [
      /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?)\s+\[([^\]]+)]\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+(\S+)\s+-\s+(.*)$/i,
      /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?)\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\[([^\]]+)]\s+(\S+)\s+-\s+(.*)$/i,
    ];
    const first = patterns[0].exec(head);
    const second = first ? undefined : patterns[1].exec(head);
    const match = first || second;
    if (!match) return undefined;

    const rawTime = match[1].replace(",", ".").replace(" ", "T");
    let timestamp: string | undefined;
    try {
      timestamp = new Date(rawTime).toISOString();
    } catch {
      timestamp = undefined;
    }

    return first
      ? {
          timestamp,
          thread: match[2],
          level: match[3],
          logger: match[4],
          message: match[5],
          stackTrace: tail.length ? tail.join("\n") : undefined,
        }
      : {
          timestamp,
          level: match[2],
          thread: match[3],
          logger: match[4],
          message: match[5],
          stackTrace: tail.length ? tail.join("\n") : undefined,
        };
  }

  private redactObject(
    value: Record<string, unknown>,
    depth = 0,
  ): Record<string, unknown> {
    if (depth > 5) return {};
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (SECRET_KEY_RE.test(key)) {
        output[key] = "***";
      } else if (typeof item === "string") {
        output[key] = this.redactText(item).slice(0, 8_000);
      } else if (Array.isArray(item)) {
        output[key] = item
          .slice(0, 50)
          .map((entry) =>
            typeof entry === "string"
              ? this.redactText(entry).slice(0, 8_000)
              : entry && typeof entry === "object"
                ? this.redactObject(entry as Record<string, unknown>, depth + 1)
                : entry,
          );
      } else if (item && typeof item === "object") {
        output[key] = this.redactObject(
          item as Record<string, unknown>,
          depth + 1,
        );
      } else {
        output[key] = item;
      }
    }
    return output;
  }

  private reason(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
