import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeployTargetService } from '../deploy/deploy-target.service';

type PrometheusValue = [number, string];
type PrometheusSeries = { metric: Record<string, string>; values?: PrometheusValue[] };

@Injectable()
export class ResourceMetricsService {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly maxResponseBytes: number;
  constructor(config: ConfigService, private readonly targets: DeployTargetService) {
    this.url = config.get<string>('PROMETHEUS_URL', 'http://prometheus:9090').replace(/\/$/, '');
    const token = config.get<string>('PROMETHEUS_BEARER_TOKEN', '');
    const username = config.get<string>('PROMETHEUS_USERNAME', '');
    const password = config.get<string>('PROMETHEUS_PASSWORD', '');
    this.maxResponseBytes = Number(config.get('PROMETHEUS_MAX_RESPONSE_BYTES', 10 * 1024 * 1024));
    this.headers = token ? { authorization: `Bearer ${token}` } : username ? { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : {};
  }

  async health() {
    const started = Date.now();
    try { const response = await fetch(`${this.url}/-/ready`, { headers: this.headers, signal: AbortSignal.timeout(2000) }); return { available: response.ok, latencyMs: Date.now() - started, ...(response.ok ? {} : { error: `HTTP ${response.status}` }) }; }
    catch (error) { return { available: false, latencyMs: Date.now() - started, error: (error as Error).message }; }
  }

  async services(minutesInput?: number) {
    const minutes = boundedNumber(minutesInput, 5, 1440, 60);
    const end = Math.floor(Date.now() / 1000), start = end - minutes * 60, step = Math.max(15, Math.ceil(minutes * 60 / 240));
    const selector = '{container_label_com_docker_compose_project="code-generator",container_label_com_docker_compose_service=~"api|worker"}';
    const queries = {
      cpu: `sum by (container_label_com_docker_compose_service) (rate(container_cpu_usage_seconds_total${selector}[2m]))`,
      memory: `sum by (container_label_com_docker_compose_service) (container_memory_working_set_bytes${selector})`,
      memoryLimit: `sum by (container_label_com_docker_compose_service) (container_spec_memory_limit_bytes${selector} > 0)`,
      networkReceive: `sum by (container_label_com_docker_compose_service) (rate(container_network_receive_bytes_total${selector}[2m]))`,
      networkTransmit: `sum by (container_label_com_docker_compose_service) (rate(container_network_transmit_bytes_total${selector}[2m]))`,
      instances: `count by (container_label_com_docker_compose_service) ((time() - container_last_seen${selector}) < 60)`,
    };
    const rows = await Promise.all(Object.entries(queries).map(async ([key, query]) => [key, await this.range(query, start, end, step)] as const));
    const services = new Map<string, Record<string, unknown>>();
    for (const [metricName, values] of rows) for (const row of values) {
      const name = row.metric.container_label_com_docker_compose_service || 'unknown';
      const item = services.get(name) || { serviceName: name };
      const points = (row.values || []).map(([timestamp, value]) => ({ timestamp: new Date(timestamp * 1000).toISOString(), value: finite(value) }));
      item[metricName] = { current: points.at(-1)?.value ?? null, points };
      services.set(name, item);
    }
    return { from: new Date(start * 1000).toISOString(), to: new Date(end * 1000).toISOString(), stepSeconds: step, services: [...services.values()] };
  }

  async kubernetesNamespaces(userId: string, targetId?: string) {
    const source = await this.targetSource(userId, targetId);
    return { targetId: source.targetId, targetName: source.targetName, namespaces: source.businessNamespaces };
  }

  async kubernetesPods(userId: string, input: { targetId: string; namespace?: string; pod?: string; podPrefix?: string; minutes?: number }) {
    const source = await this.targetSource(userId, input.targetId);
    const namespace = safeLabel(input.namespace, 'Namespace');
    const pod = safeLabel(input.pod, 'Pod');
    const podPrefix = safeLabel(input.podPrefix, 'Pod 前缀');
    const minutes = boundedNumber(input.minutes, 5, 1440, 60);
    const end = Math.floor(Date.now() / 1000), start = end - minutes * 60, step = Math.max(15, Math.ceil(minutes * 60 / 240));
    if (namespace && !source.businessNamespaces.includes(namespace)) throw new BadRequestException('所选 Namespace 不属于该部署目标的业务空间');
    const matchers = ['namespace!=""', 'pod!=""', ...source.metricMatchers];
    if (namespace) matchers.push(`namespace="${namespace}"`);
    else matchers.push(`namespace=~"${source.businessNamespaces.map(escapePromRegex).join('|')}"`);
    if (pod) matchers.push(`pod="${pod}"`);
    else if (podPrefix) matchers.push(`pod=~"${escapePromRegex(podPrefix)}-.*"`);
    const selector = `{${matchers.join(',')}}`;
    const containerSelector = `{${[...matchers, 'container!=""', 'container!="POD"'].join(',')}}`;
    const queries = {
      cpu: `sum by (namespace, pod) (rate(container_cpu_usage_seconds_total${containerSelector}[2m]))`,
      memory: `sum by (namespace, pod) (container_memory_working_set_bytes${containerSelector})`,
      networkReceive: `sum by (namespace, pod) (rate(container_network_receive_bytes_total${selector}[2m]))`,
      networkTransmit: `sum by (namespace, pod) (rate(container_network_transmit_bytes_total${selector}[2m]))`,
      restarts: `sum by (namespace, pod) (kube_pod_container_status_restarts_total${selector})`,
      ready: `min by (namespace, pod) (kube_pod_status_ready{${[...matchers, 'condition="true"'].join(',')}})`,
    };
    const rows = await Promise.all(Object.entries(queries).map(async ([key, query]) => [key, await this.range(query, start, end, step, source)] as const));
    const pods = new Map<string, Record<string, unknown>>();
    for (const [metricName, values] of rows) for (const row of values) {
      const namespaceName = row.metric.namespace || 'unknown', podName = row.metric.pod || 'unknown', key = `${namespaceName}/${podName}`;
      const item = pods.get(key) || { namespace: namespaceName, podName };
      const points = (row.values || []).map(([timestamp, value]) => ({ timestamp: new Date(timestamp * 1000).toISOString(), value: finite(value) }));
      item[metricName] = { current: points.at(-1)?.value ?? null, points };
      pods.set(key, item);
    }
    return { targetId: source.targetId, targetName: source.targetName, from: new Date(start * 1000).toISOString(), to: new Date(end * 1000).toISOString(), stepSeconds: step, sourceAvailable: pods.size > 0, pods: [...pods.values()] };
  }

  private async targetSource(userId: string, targetId?: string) {
    if (!targetId) throw new BadRequestException('请选择 Kubernetes 部署目标');
    const target = await this.targets.resolveConfig(userId, targetId);
    if (target.kind !== 'k8s') throw new BadRequestException('所选部署目标不是 Kubernetes 集群');
    if (!target.enabled) throw new BadRequestException('所选部署目标已停用');
    const url = String(target.config.prometheusUrl || '').replace(/\/$/, '');
    if (!url) throw new BadRequestException('该部署目标尚未配置 Prometheus 地址');
    const token = String(target.config.prometheusBearerToken || '');
    const username = String(target.config.prometheusUsername || '');
    const password = String(target.config.prometheusPassword || '');
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : username ? { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : {};
    const businessNamespaces = [...new Set([target.config.namespace, ...(Array.isArray(target.config.businessNamespaces) ? target.config.businessNamespaces : [])].map((value) => String(value || '').trim()).filter((value) => value && !isSystemNamespace(value)))];
    if (!businessNamespaces.length) throw new BadRequestException('该部署目标尚未配置业务 Namespace');
    const clusterLabel = String(target.config.prometheusClusterLabel || '').trim();
    const clusterValue = String(target.config.prometheusClusterValue || '').trim();
    const metricMatchers = clusterLabel && clusterValue ? [`${clusterLabel}="${clusterValue}"`] : [];
    return { url, headers, targetId: target.id, targetName: target.name, businessNamespaces, metricMatchers };
  }

  private async range(query: string, start: number, end: number, step: number, source?: { url: string; headers: Record<string, string> }): Promise<PrometheusSeries[]> {
    const params = new URLSearchParams({ query, start: String(start), end: String(end), step: String(step) });
    const body = record(await this.prometheus(`/api/v1/query_range?${params}`, source));
    const data = record(body.data);
    return array(data.result).slice(0, 1000).map(parseSeries).filter((row): row is PrometheusSeries => !!row);
  }

  private async prometheus(path: string, source?: { url: string; headers: Record<string, string> }): Promise<unknown> {
    const response = await fetch(`${source?.url || this.url}${path}`, { headers: source?.headers || this.headers, signal: AbortSignal.timeout(10_000) });
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > this.maxResponseBytes) { await response.body?.cancel(); throw new BadGatewayException('Prometheus 响应超过平台大小限制'); }
    const textBody = await readLimitedText(response, this.maxResponseBytes);
    let parsed: unknown;
    try { parsed = textBody ? JSON.parse(textBody) : {}; } catch { throw new BadGatewayException('Prometheus 返回了非法 JSON'); }
    const body = record(parsed);
    const error = typeof body.error === 'string' ? body.error.slice(0, 500) : '';
    if (!response.ok || body.status !== 'success') throw new BadGatewayException(`Prometheus 查询失败: ${error || `HTTP ${response.status}`}`);
    return body;
  }
}
function boundedNumber(value: unknown, min: number, max: number, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback; }
function finite(value: string) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function safeLabel(value: unknown, name: string) { const text = String(value || '').trim(); if (!text) return ''; if (!/^[a-zA-Z0-9_.:-]{1,253}$/.test(text)) throw new BadRequestException(`${name} 格式非法`); return text; }
function isSystemNamespace(value: string) { return value === 'default' || value === 'kube-public' || value === 'kube-node-lease' || value === 'codegen-observability' || value.startsWith('kube-'); }
function escapePromRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function parseSeries(value: unknown): PrometheusSeries | null { const row = record(value); const rawMetric = record(row.metric); const metric: Record<string, string> = {}; for (const [key, item] of Object.entries(rawMetric).slice(0, 100)) if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && typeof item === 'string') metric[key] = item.slice(0, 1000); const values: PrometheusValue[] = []; for (const point of array(row.values).slice(0, 1000)) { if (!Array.isArray(point) || point.length < 2) continue; const timestamp = Number(point[0]); if (!Number.isFinite(timestamp) || typeof point[1] !== 'string') continue; values.push([timestamp, point[1].slice(0, 100)]); } return { metric, values }; }
async function readLimitedText(response: Response, limit: number) { if (!response.body) return ''; const reader = response.body.getReader(); const decoder = new TextDecoder(); let total = 0; let output = ''; try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > limit) { await reader.cancel(); throw new BadGatewayException('Prometheus 响应超过平台大小限制'); } output += decoder.decode(value, { stream: true }); } return output + decoder.decode(); } finally { reader.releaseLock(); } }
