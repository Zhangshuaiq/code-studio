import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface OpenSearchResponseError {
  error?: { reason?: string; root_cause?: Array<{ reason?: string }> } | string;
  status?: number;
}

@Injectable()
export class OpenSearchService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OpenSearchService.name);
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private templateReady = false;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = config
      .get<string>("OPENSEARCH_URL", "http://localhost:9200")
      .replace(/\/+$/, "");
    this.username = config.get<string>("OPENSEARCH_USERNAME", "");
    this.password = config.get<string>("OPENSEARCH_PASSWORD", "");
    this.timeoutMs = Number(config.get("OPENSEARCH_TIMEOUT_MS", 15_000));
    this.maxResponseBytes = Number(config.get("OPENSEARCH_MAX_RESPONSE_BYTES", 20 * 1024 * 1024));
  }

  async onApplicationBootstrap() {
    try {
      await this.ensureIndexTemplate();
      this.logger.log(`OpenSearch 日志索引模板已就绪: ${this.baseUrl}`);
    } catch (error) {
      // OpenSearch 可以晚于 API 启动；首次写入时会再次尝试创建模板。
      this.logger.warn(`OpenSearch 暂不可用: ${this.reason(error)}`);
    }
  }

  async ensureIndexTemplate(force = false) {
    if (this.templateReady && !force) return;
    const shards = Math.max(
      1,
      Number(this.config.get("OPENSEARCH_LOG_SHARDS", 1)),
    );
    const replicas = Math.max(
      0,
      Number(this.config.get("OPENSEARCH_LOG_REPLICAS", 0)),
    );
    await this.request("PUT", "/_index_template/code-studio-business-logs", {
      index_patterns: ["business-logs-*"],
      priority: 200,
      version: 2,
      _meta: { owner: "code-studio", purpose: "business-logs" },
      template: {
        settings: {
          number_of_shards: shards,
          number_of_replicas: replicas,
          refresh_interval: "5s",
          codec: "best_compression",
        },
        aliases: { "business-logs-all": {} },
        mappings: {
          dynamic: false,
          properties: {
            "@timestamp": { type: "date" },
            ingested_at: { type: "date" },
            event_id: { type: "keyword" },
            project_id: { type: "keyword" },
            team_id: { type: "keyword" },
            source_id: { type: "keyword" },
            source_name: { type: "keyword" },
            environment: { type: "keyword" },
            service_name: { type: "keyword" },
            level: { type: "keyword" },
            logger: { type: "keyword", ignore_above: 512 },
            thread: { type: "keyword", ignore_above: 256 },
            trace_id: { type: "keyword", ignore_above: 256 },
            span_id: { type: "keyword", ignore_above: 256 },
            event_type: { type: "keyword" },
            http_method: { type: "keyword" },
            http_route: { type: "keyword", ignore_above: 512 },
            status_code: { type: "integer" },
            business_code: { type: "keyword", ignore_above: 128 },
            success: { type: "boolean" },
            duration_ms: { type: "double" },
            deployment_id: { type: "keyword" },
            version: { type: "keyword", ignore_above: 256 },
            message: { type: "text" },
            stack_trace: { type: "text" },
            attributes_text: { type: "text" },
            attributes: { type: "object", enabled: false },
          },
        },
      },
    });
    // 模板只作用于新索引；同步扩展已存在的按日索引，保证升级后当天即可聚合指标。
    try {
      await this.request(
        "PUT",
        "/business-logs-*/_mapping?ignore_unavailable=true&allow_no_indices=true",
        {
          properties: {
            event_type: { type: "keyword" },
            http_method: { type: "keyword" },
            http_route: { type: "keyword", ignore_above: 512 },
            status_code: { type: "integer" },
            business_code: { type: "keyword", ignore_above: 128 },
            success: { type: "boolean" },
            duration_ms: { type: "double" },
            deployment_id: { type: "keyword" },
            version: { type: "keyword", ignore_above: 256 },
          },
        },
      );
    } catch (error) {
      if (this.status(error) !== 404) throw error;
    }
    this.templateReady = true;
  }

  async bulk(
    entries: Array<{ index: string; routing: string; document: unknown }>,
  ): Promise<{ accepted: number; failed: number; errors: string[] }> {
    if (entries.length === 0) return { accepted: 0, failed: 0, errors: [] };
    const ndjson =
      entries
        .flatMap((entry) => [
          JSON.stringify({
            index: { _index: entry.index, routing: entry.routing },
          }),
          JSON.stringify(entry.document),
        ])
        .join("\n") + "\n";
    const result = await this.request<{
      errors: boolean;
      items: Array<{
        index?: { status?: number; error?: { reason?: string } };
      }>;
    }>("POST", "/_bulk", ndjson, "application/x-ndjson");
    const failedItems = (result.items ?? []).filter(
      (item) => (item.index?.status ?? 500) >= 300,
    );
    return {
      accepted: entries.length - failedItems.length,
      failed: failedItems.length,
      errors: failedItems
        .slice(0, 5)
        .map((item) => item.index?.error?.reason || "OpenSearch 写入失败"),
    };
  }

  search<T>(indices: string[], body: unknown, routing?: string): Promise<T> {
    const target = indices.join(",");
    const params = new URLSearchParams({
      ignore_unavailable: "true",
      allow_no_indices: "true",
    });
    if (routing) params.set("routing", routing);
    return this.request<T>("POST", `/${target}/_search?${params}`, body);
  }

  async health() {
    const started = Date.now();
    const health = await this.request<{
      cluster_name: string;
      status: string;
      number_of_nodes: number;
      active_shards: number;
    }>("GET", "/_cluster/health");
    return {
      available: true,
      clusterName: health.cluster_name,
      status: health.status,
      nodes: health.number_of_nodes,
      activeShards: health.active_shards,
      latencyMs: Date.now() - started,
    };
  }

  async listLogIndices(): Promise<
    Array<{ index: string; docsCount?: string; storeSize?: string }>
  > {
    try {
      return await this.request<
        Array<{ index: string; docsCount?: string; storeSize?: string }>
      >(
        "GET",
        "/_cat/indices/business-logs-*?format=json&h=index,docs.count,store.size",
      );
    } catch (error) {
      if (this.status(error) === 404) return [];
      throw error;
    }
  }

  deleteIndex(index: string) {
    if (!/^business-logs-\d{4}\.\d{2}\.\d{2}$/.test(index)) {
      throw new Error(`拒绝删除非业务日志索引: ${index}`);
    }
    return this.request("DELETE", `/${index}`);
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = contentType;
    if (this.username) {
      headers.Authorization = `Basic ${Buffer.from(
        `${this.username}:${this.password}`,
      ).toString("base64")}`;
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : typeof body === "string"
              ? body
              : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `OpenSearch 连接失败: ${this.reason(error)}`,
      );
    }

    const text = await this.readResponseText(response);
    const data = text ? this.parse(text) : {};
    if (!response.ok) {
      const err = new Error(
        `OpenSearch ${response.status}: ${this.errorReason(data)}`,
      ) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }
    return data as T;
  }

  private async readResponseText(response: Response) {
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > this.maxResponseBytes) {
      await response.body?.cancel();
      throw new ServiceUnavailableException("OpenSearch 响应超过平台大小限制");
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel();
          throw new ServiceUnavailableException("OpenSearch 响应超过平台大小限制");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(merged);
  }

  private parse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private errorReason(data: unknown): string {
    const value = data as OpenSearchResponseError;
    if (typeof value?.error === "string") return value.error;
    return (
      value?.error?.root_cause?.[0]?.reason ||
      value?.error?.reason ||
      JSON.stringify(data).slice(0, 500)
    );
  }

  private status(error: unknown): number | undefined {
    return (error as { status?: number })?.status;
  }

  private reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
