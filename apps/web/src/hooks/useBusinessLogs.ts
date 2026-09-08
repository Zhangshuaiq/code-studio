import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../lib/api";

export interface BusinessLogItem {
  id: string;
  index: string;
  "@timestamp": string;
  ingested_at: string;
  project_id: string;
  source_id: string;
  source_name: string;
  environment: string;
  service_name: string;
  level: string;
  logger?: string | null;
  thread?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  message: string;
  stack_trace?: string | null;
  attributes?: Record<string, unknown>;
}

export interface LogFacet {
  value: string;
  count: number;
}

export interface BusinessLogPage {
  items: BusinessLogItem[];
  total: number;
  totalRelation: "eq" | "gte";
  tookMs: number;
  timedOut: boolean;
  nextCursor: string | null;
  facets: {
    levels: LogFacet[];
    services: LogFacet[];
    environments: LogFacet[];
  };
  timeline: Array<{ time: string; count: number }>;
}

export interface BusinessLogSearch {
  projectId: string;
  from: string;
  to: string;
  environment?: string;
  serviceName?: string;
  levels?: string[];
  query?: string;
  traceId?: string;
  limit?: number;
}

export interface BusinessLogSource {
  id: string;
  projectId: string;
  name: string;
  environment: string;
  serviceName: string;
  format: "json" | "log4j";
  status: "active" | "disabled";
  tokenPrefix: string;
  lastIngestedAt: string | null;
  createdAt: string;
  updatedAt?: string;
  project?: { name: string };
}

export interface BusinessLogPolicy {
  retentionDays: number;
  defaultQueryRangeMinutes: number;
  maxQueryRangeHours: number;
  maxResultLines: number;
  queryTimeoutSeconds: number;
}

export interface ApplicationMetrics {
  total: number;
  successful: number;
  failed: number;
  successRate: number;
  averageLatencyMs: number;
  latency: { p50: number; p90: number; p95: number; p99: number };
  statusCodes: Array<{ code: number; count: number }>;
  environments: LogFacet[];
  services: LogFacet[];
  timeline: Array<{
    time: string;
    total: number;
    successful: number;
    failed: number;
    successRate: number;
    p95Ms: number;
  }>;
  routes: Array<{
    method: string;
    route: string;
    total: number;
    successful: number;
    failed: number;
    successRate: number;
    averageLatencyMs: number;
    p95Ms: number;
  }>;
  tookMs: number;
  timedOut: boolean;
}

export interface PlatformMetricSummary {
  total: number;
  successful: number;
  failed: number;
  successRate: number;
  statuses: Record<string, number>;
}

export interface PlatformMetrics {
  generation: PlatformMetricSummary;
  deployment: PlatformMetricSummary;
  preview: PlatformMetricSummary;
  sandbox: PlatformMetricSummary;
  from: string;
  to: string;
}

export interface MonitoringAlertRule {
  id: string; projectId: string; name: string;
  metric: "success_rate" | "error_rate" | "p95_latency_ms";
  operator: "lt" | "gt"; threshold: number; windowMinutes: number;
  enabled: boolean; cooldownMinutes: number; lastTriggeredAt?: string | null;
  state: "ok" | "firing"; lastValue?: number | null; lastEvaluatedAt?: string | null;
}

export interface MonitoringAlertEvent {
  id: string; ruleId: string; metric: string; value: number; threshold: number;
  status: string; message: string; createdAt: string; rule: { name: string };
  notificationStatus: "pending" | "sent" | "failed" | "in_app";
  notificationError?: string | null;
}

export function useApplicationMetrics(input: {
  projectId: string;
  from: string;
  to: string;
  environment?: string;
  serviceName?: string;
}) {
  return useQuery<ApplicationMetrics>({
    queryKey: ["application-metrics", input],
    enabled: !!input.projectId,
    queryFn: async () =>
      (await api.post("/business-logs/metrics", input)).data,
    refetchInterval: 30_000,
    retry: 1,
  });
}

export function usePlatformMetrics(input: {
  projectId: string;
  from: string;
  to: string;
}) {
  return useQuery<PlatformMetrics>({
    queryKey: ["platform-metrics", input],
    enabled: !!input.projectId,
    queryFn: async () =>
      (await api.post("/business-logs/platform-metrics", input)).data,
    refetchInterval: 30_000,
    retry: 1,
  });
}

export function useMonitoringAlerts(projectId: string) {
  const qc = useQueryClient();
  const rules = useQuery<MonitoringAlertRule[]>({
    queryKey: ["monitoring-alert-rules", projectId],
    enabled: !!projectId,
    queryFn: async () => (await api.get(`/business-logs/alert-rules/${projectId}`)).data,
  });
  const events = useQuery<MonitoringAlertEvent[]>({
    queryKey: ["monitoring-alert-events", projectId],
    enabled: !!projectId,
    queryFn: async () => (await api.get(`/business-logs/alert-events/${projectId}`, { params: { pageSize: 100 } })).data.items,
    refetchInterval: 30_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["monitoring-alert-rules", projectId] });
  const create = useMutation({
    mutationFn: (input: Omit<MonitoringAlertRule, "id" | "enabled" | "lastTriggeredAt" | "state" | "lastValue" | "lastEvaluatedAt">) => api.post("/business-logs/alert-rules", input),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/business-logs/alert-rules/${id}`),
    onSuccess: refresh,
  });
  return { rules, events, create, remove };
}

export interface AlertNotificationConfig {
  enabled: boolean; url: string; configured: boolean; secretConfigured: boolean;
  source: "database" | "environment";
}

export function useAlertNotificationConfig(enabled: boolean) {
  const qc = useQueryClient();
  const query = useQuery<AlertNotificationConfig>({
    queryKey: ["alert-notification-config"], enabled,
    queryFn: async () => (await api.get("/business-logs/alert-notification")).data,
  });
  const save = useMutation({
    mutationFn: (input: { enabled: boolean; url?: string; secret?: string; clearSecret?: boolean }) => api.put("/business-logs/alert-notification", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-notification-config"] }),
  });
  const test = useMutation({ mutationFn: () => api.post("/business-logs/alert-notification/test") });
  return { query, save, test };
}

export function useBusinessLogSearch(
  search: BusinessLogSearch | null,
  sequence: number,
) {
  return useInfiniteQuery<BusinessLogPage>({
    queryKey: ["business-logs", search, sequence],
    enabled: !!search?.projectId,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.post("/business-logs/search", {
          ...search,
          cursor: pageParam || undefined,
        })
      ).data,
    getNextPageParam: (last) => last.nextCursor || undefined,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useBusinessLogHealth() {
  return useQuery<{
    available: boolean;
    status?: string;
    latencyMs?: number;
    indexCount?: number;
    documents?: number;
    error?: string;
  }>({
    queryKey: ["business-log-health"],
    queryFn: async () => (await api.get("/business-logs/health")).data,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useBusinessLogPolicy() {
  return useQuery<BusinessLogPolicy>({
    queryKey: ["business-log-policy"],
    queryFn: async () => (await api.get("/business-logs/policy")).data,
  });
}

export function useBusinessLogPolicyMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policy: BusinessLogPolicy) =>
      api.put("/business-logs/policy", policy).then((r) => r.data),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["business-log-policy"] }),
  });
}

export function useBusinessLogSources(enabled = true) {
  return useQuery<BusinessLogSource[]>({
    queryKey: ["business-log-sources"],
    enabled,
    queryFn: async () => (await api.get("/business-logs/sources")).data,
  });
}

export function useBusinessLogSourceMutations() {
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["business-log-sources"] });
  const create = useMutation({
    mutationFn: (input: {
      projectId: string;
      name: string;
      environment: string;
      serviceName: string;
      format: "json" | "log4j";
    }) =>
      api
        .post("/business-logs/sources", input)
        .then((r) => r.data as BusinessLogSource & { token: string }),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: ({
      id,
      ...input
    }: Partial<BusinessLogSource> & { id: string }) =>
      api.patch(`/business-logs/sources/${id}`, input),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: (id: string) =>
      api
        .post(`/business-logs/sources/${id}/rotate-token`)
        .then(
          (r) => r.data as { id: string; token: string; tokenPrefix: string },
        ),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/business-logs/sources/${id}`),
    onSuccess: refresh,
  });
  return { create, update, rotate, remove };
}
