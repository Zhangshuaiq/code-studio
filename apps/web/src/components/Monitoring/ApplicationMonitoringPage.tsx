import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Clock3, Gauge, RefreshCw, Route, Server, Trash2 } from "lucide-react";
import { useAlertNotificationConfig, useApplicationMetrics, useMonitoringAlerts, usePlatformMetrics } from "../../hooks/useBusinessLogs";
import { useProjects } from "../../hooks/useProjects";
import { useMe } from "../../hooks/useMe";
import { Select } from "../common/Select";
import { useProjectResourceUsage } from "../../hooks/usePlatformHealth";
import { api } from "../../lib/api";
import { InteractiveLineChart } from "./InteractiveLineChart";

const RANGES = [
  { value: "60", label: "最近 1 小时" },
  { value: "360", label: "最近 6 小时" },
  { value: "1440", label: "最近 24 小时" },
  { value: "10080", label: "最近 7 天" },
];

export function ApplicationMonitoringPage() {
  const me = useMe();
  const projects = useProjects();
  const [projectId, setProjectId] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [environment, setEnvironment] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!projectId && projects.data?.[0]) setProjectId(projects.data[0].id);
  }, [projectId, projects.data]);
  const input = useMemo(() => ({
    projectId,
    from: new Date(now - Number(minutes) * 60_000).toISOString(),
    to: new Date(now).toISOString(),
    environment: environment || undefined,
    serviceName: serviceName || undefined,
  }), [projectId, minutes, environment, serviceName, now]);
  const query = useApplicationMetrics(input);
  const platformQuery = usePlatformMetrics(input);
  const alerts = useMonitoringAlerts(projectId);
  const resourceUsage = useProjectResourceUsage(projectId);
  const runtimeResources = useQuery<ResourceMetricsResponse>({
    queryKey: ["resource-metrics", minutes, now],
    queryFn: async () => (await api.get("/resource-metrics/services", { params: { minutes } })).data,
    refetchInterval: 30_000,
    retry: false,
  });
  const data = query.data;
  const platform = platformQuery.data;
  const canRead = !!me.data?.permissions.includes("business-log:read");
  const canManageNotifications = !!me.data?.permissions.includes("system-setting:manage");
  if (!canRead && !me.isLoading) {
    return <div className="card mx-auto mt-20 max-w-md p-10 text-center"><AlertTriangle className="mx-auto text-amber-500" /><p className="mt-3 font-bold">无权查看应用监控</p></div>;
  }
  return (
    <div className="h-full overflow-y-auto rounded-[22px] border border-white/80 bg-white/45 dark:border-slate-800/80 dark:bg-slate-950/25">
      <div className="page-shell max-w-[1600px]">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div><div className="eyebrow">Application Observability</div><h1 className="mt-1 text-2xl font-bold">应用监控</h1><p className="mt-1 text-sm text-muted">接口成功率、请求趋势与延迟分位分析</p></div>
          <div className="flex flex-wrap items-end gap-2">
            <Filter label="项目"><Select value={projectId} onChange={setProjectId} options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))} /></Filter>
            <Filter label="时间范围"><Select value={minutes} onChange={(v) => { setMinutes(v); setNow(Date.now()); }} options={RANGES} /></Filter>
            <Filter label="环境"><input className="input h-10 w-32" value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="全部" /></Filter>
            <Filter label="服务"><input className="input h-10 w-36" value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="全部" /></Filter>
            <button className="btn btn-primary h-10" onClick={() => setNow(Date.now())}><RefreshCw size={14} className={query.isFetching ? "animate-spin" : ""} />刷新</button>
          </div>
        </header>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat icon={<Gauge size={17} />} label="接口成功率" value={data ? `${data.successRate.toFixed(2)}%` : "—"} hint={`${fmt(data?.successful)} 成功 · ${fmt(data?.failed)} 失败`} tone={(data?.successRate ?? 100) < 99 ? "red" : "green"} />
          <Stat icon={<Activity size={17} />} label="请求总量" value={fmt(data?.total)} hint="筛选时段内 HTTP 请求" />
          <Stat icon={<Clock3 size={17} />} label="P95 延迟" value={data ? ms(data.latency.p95) : "—"} hint={`P50 ${ms(data?.latency.p50)} · P99 ${ms(data?.latency.p99)}`} tone={(data?.latency.p95 ?? 0) > 1000 ? "red" : "indigo"} />
          <Stat icon={<Server size={17} />} label="平均响应" value={data ? ms(data.averageLatencyMs) : "—"} hint={`聚合耗时 ${data?.tookMs ?? 0} ms`} />
        </div>

        <section className="card mt-4 p-5">
          <Title title="平台工作流质量" subtitle="生成与部署按所选时段统计；预览和沙箱展示当前实例健康度" />
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <WorkflowStat label="AI 生成成功率" metric={platform?.generation} />
            <WorkflowStat label="部署成功率" metric={platform?.deployment} />
            <WorkflowStat label="预览健康率" metric={platform?.preview} />
            <WorkflowStat label="沙箱健康率" metric={platform?.sandbox} />
          </div>
        </section>

        <AlertPanel projectId={projectId} alerts={alerts} />
        {canManageNotifications && <AlertNotificationSettings />}

        <ResourceUsage usage={resourceUsage.data} />
        <RuntimeResources data={runtimeResources.data} error={runtimeResources.error} />

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <section className="card p-5"><Title title="成功率趋势" subtitle="请求量与成功率随时间变化" /><Trend points={data?.timeline ?? []} /></section>
          <section className="card p-5"><Title title="状态码分布" subtitle="HTTP 响应结果" /><div className="mt-5 space-y-3">{(data?.statusCodes ?? []).map((item) => { const percent = data?.total ? item.count / data.total * 100 : 0; return <div key={item.code}><div className="mb-1 flex justify-between text-xs"><span className="font-mono font-bold">{item.code}</span><span className="text-muted">{fmt(item.count)} · {percent.toFixed(1)}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className={`h-full rounded-full ${item.code >= 500 ? "bg-red-500" : item.code >= 400 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${percent}%` }} /></div></div>; })}{!data?.statusCodes.length && <Empty />}</div></section>
        </div>

        <section className="card mt-4 overflow-hidden"><div className="p-5"><Title title="接口质量" subtitle="按请求量排序，快速定位失败和慢接口" /></div><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-y bg-slate-50 text-slate-500 dark:border-slate-800 dark:bg-slate-900/60"><tr>{["接口","请求量","成功率","失败","平均延迟","P95"].map((x) => <th key={x} className="px-5 py-3 font-semibold">{x}</th>)}</tr></thead><tbody>{(data?.routes ?? []).map((item) => <tr key={`${item.method}-${item.route}`} className="border-b border-slate-100 dark:border-slate-800/70"><td className="px-5 py-3"><span className="mr-2 rounded bg-indigo-50 px-1.5 py-1 font-mono font-bold text-indigo-600 dark:bg-indigo-500/10">{item.method}</span><span className="font-mono">{item.route}</span></td><td className="px-5 py-3">{fmt(item.total)}</td><td className={`px-5 py-3 font-bold ${item.successRate < 99 ? "text-red-500" : "text-emerald-600"}`}>{item.successRate.toFixed(2)}%</td><td className="px-5 py-3 text-red-500">{fmt(item.failed)}</td><td className="px-5 py-3">{ms(item.averageLatencyMs)}</td><td className="px-5 py-3">{ms(item.p95Ms)}</td></tr>)}</tbody></table>{!data?.routes.length && <div className="p-10"><Empty /></div>}</div></section>
      </div>
    </div>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="label mb-1 block">{label}</label>{children}</div>; }
function Title({ title, subtitle }: { title: string; subtitle: string }) { return <div><h2 className="font-bold">{title}</h2><p className="mt-0.5 text-xs text-muted">{subtitle}</p></div>; }
function Empty() { return <div className="flex flex-col items-center py-8 text-center text-xs text-muted"><Route size={24} className="mb-2 opacity-40" />暂无 HTTP 请求指标，请按接入说明上报结构化属性</div>; }
function Stat({ icon, label, value, hint, tone = "indigo" }: { icon: React.ReactNode; label: string; value: string; hint: string; tone?: "indigo" | "green" | "red" }) { const color = tone === "green" ? "text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10" : tone === "red" ? "text-red-600 bg-red-50 dark:bg-red-500/10" : "text-indigo-600 bg-indigo-50 dark:bg-indigo-500/10"; return <div className="card p-4"><div className={`mb-3 grid h-8 w-8 place-items-center rounded-xl ${color}`}>{icon}</div><div className="text-xs text-muted">{label}</div><div className="mt-1 text-2xl font-bold tracking-tight">{value}</div><div className="mt-1 text-[10px] text-muted">{hint}</div></div>; }
function WorkflowStat({ label, metric }: { label: string; metric?: { total: number; successful: number; failed: number; successRate: number } }) { const hasResult = !!metric && metric.successful + metric.failed > 0; const healthy = !hasResult || metric.successRate >= 95; return <div className="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-900/50"><div className="flex items-center justify-between"><span className="text-xs font-semibold text-muted">{label}</span><span className={`h-2.5 w-2.5 rounded-full ${healthy ? "bg-emerald-500" : "bg-red-500"}`} /></div><div className={`mt-2 text-xl font-bold ${hasResult && !healthy ? "text-red-500" : ""}`}>{hasResult ? `${metric.successRate.toFixed(2)}%` : "暂无结果"}</div><div className="mt-1 text-[10px] text-muted">{metric ? `${fmt(metric.successful)} 成功 · ${fmt(metric.failed)} 失败 · ${fmt(metric.total)} 总计` : "正在加载"}</div></div>; }
function AlertPanel({ projectId, alerts }: { projectId: string; alerts: ReturnType<typeof useMonitoringAlerts> }) { const [metric, setMetric] = useState<"success_rate" | "p95_latency_ms">("success_rate"); const [threshold, setThreshold] = useState("99"); const add = () => { const latency = metric === "p95_latency_ms"; alerts.create.mutate({ projectId, name: latency ? `P95 延迟超过 ${threshold}ms` : `接口成功率低于 ${threshold}%`, metric, operator: latency ? "gt" : "lt", threshold: Number(threshold), windowMinutes: 5, cooldownMinutes: 15 }); }; return <section className="card mt-4 p-5"><Title title="告警规则与事件" subtitle="每分钟评估，默认 5 分钟窗口、15 分钟静默；支持站内事件和服务端 Webhook" /><div className="mt-4 flex flex-wrap gap-2"><Select value={metric} onChange={(v) => { const next = v as typeof metric; setMetric(next); setThreshold(next === "success_rate" ? "99" : "1000"); }} options={[{ value: "success_rate", label: "成功率低于" }, { value: "p95_latency_ms", label: "P95 延迟高于" }]} /><input className="input h-10 w-28" type="number" min="0" value={threshold} onChange={(e) => setThreshold(e.target.value)} /><button className="btn btn-primary" disabled={!projectId || alerts.create.isPending || !Number.isFinite(Number(threshold))} onClick={add}>添加规则</button></div><div className="mt-4 grid gap-4 lg:grid-cols-2"><div><div className="mb-2 text-xs font-bold">规则</div><div className="space-y-2">{(alerts.rules.data ?? []).map((rule) => <div key={rule.id} className="flex items-center justify-between rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-800"><div><div className="font-semibold">{rule.name}</div><div className="mt-1 text-muted">{rule.windowMinutes} 分钟窗口 · 静默 {rule.cooldownMinutes} 分钟</div></div><button className="btn btn-ghost px-2" onClick={() => alerts.remove.mutate(rule.id)} aria-label="删除规则"><Trash2 size={14} /></button></div>)}{!alerts.rules.data?.length && <div className="text-xs text-muted">暂无告警规则</div>}</div></div><div><div className="mb-2 text-xs font-bold">最近告警</div><div className="max-h-52 space-y-2 overflow-y-auto">{(alerts.events.data ?? []).slice(0, 10).map((event) => <div key={event.id} className="rounded-xl border border-red-200 bg-red-50/60 p-3 text-xs dark:border-red-900/50 dark:bg-red-950/20"><div className="flex justify-between gap-2"><span className="font-semibold text-red-600">{event.rule.name}</span><span className="text-[10px] text-muted">{deliveryLabel(event.notificationStatus)}</span></div><div className="mt-1 text-muted">{event.message}</div><div className="mt-1 text-[10px] text-muted">{new Date(event.createdAt).toLocaleString("zh-CN")}</div>{event.notificationError && <div className="mt-1 text-[10px] text-red-500">通知失败：{event.notificationError}</div>}</div>)}{!alerts.events.data?.length && <div className="text-xs text-muted">暂无触发记录</div>}</div></div></div></section>; }
function ResourceUsage({ usage }: { usage?: import("../../hooks/usePlatformHealth").ProjectResourceUsage }) { return <section className="card mt-4 p-5"><Title title="资源用量与配额" subtitle="生成量按最近 24 小时滚动统计，预览和沙箱为当前用量" /><div className="mt-4 grid gap-4 md:grid-cols-3"><UsageBar label="生成任务" used={usage?.generation.used} limit={usage?.generation.limit} suffix={`活跃 ${usage?.generation.active ?? 0}`} /><UsageBar label="运行预览" used={usage?.previews.used} limit={usage?.previews.limit} suffix="项目并发配额" /><div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800"><div className="text-xs font-semibold text-muted">运行沙箱</div><div className="mt-2 text-2xl font-bold">{usage?.sandboxes.running ?? "—"}</div><div className="mt-1 text-[10px] text-muted">每实例 {usage?.sandboxes.perInstanceCpu ?? "—"} CPU · {usage?.sandboxes.perInstanceMemoryMb ?? "—"} MB</div></div></div></section>; }
type MetricSeries = { current: number | null; points: Array<{ timestamp: string; value: number }> };
type ResourceService = { serviceName: string; cpu?: MetricSeries; memory?: MetricSeries; memoryLimit?: MetricSeries; networkReceive?: MetricSeries; networkTransmit?: MetricSeries; instances?: MetricSeries };
type ResourceMetricsResponse = { from: string; to: string; stepSeconds: number; services: ResourceService[] };
function RuntimeResources({ data, error }: { data?: ResourceMetricsResponse; error: Error | null }) { return <section className="card mt-4 p-5"><Title title="服务 CPU 与内存" subtitle="Prometheus 持久化、cAdvisor 采集；每 30 秒自动刷新" />{error && <div className="mt-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-500/10">资源指标暂不可用：{(error as any)?.response?.data?.message || error.message}</div>}<div className="mt-4 grid gap-4 lg:grid-cols-2">{(data?.services ?? []).map((service) => { const memoryPercent = service.memory?.current != null && service.memoryLimit?.current ? service.memory.current / service.memoryLimit.current * 100 : null; return <article key={service.serviceName} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800"><div className="flex items-start justify-between"><div><div className="font-bold">{serviceLabel(service.serviceName)}</div><div className="mt-1 text-[10px] text-muted">{service.instances?.current ?? 0} 个采集实例</div></div><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${(service.instances?.current ?? 0) > 0 ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10" : "bg-red-50 text-red-600 dark:bg-red-500/10"}`}>{(service.instances?.current ?? 0) > 0 ? "运行中" : "实例消失"}</span></div><div className="mt-4 grid grid-cols-2 gap-3"><MetricValue label="CPU" value={service.cpu?.current == null ? "—" : `${(service.cpu.current * 100).toFixed(1)}%`} /><MetricValue label="工作集内存" value={service.memory?.current == null ? "—" : bytes(service.memory.current)} hint={memoryPercent == null ? undefined : `限制的 ${memoryPercent.toFixed(1)}%`} /><MetricValue label="网络接收" value={rate(service.networkReceive?.current)} /><MetricValue label="网络发送" value={rate(service.networkTransmit?.current)} /></div><div className="mt-4 grid gap-3 sm:grid-cols-2"><MiniTrend label="CPU 趋势" points={service.cpu?.points ?? []} color="indigo" format={(v) => `${(v * 100).toFixed(1)}%`} /><MiniTrend label="内存趋势" points={service.memory?.points ?? []} color="emerald" format={bytes} /></div></article>; })}{!error && !data?.services.length && <div className="col-span-full py-10 text-center text-xs text-muted">等待 Prometheus 完成首轮容器指标采集…</div>}</div></section>; }
function MetricValue({ label, value, hint }: { label: string; value: string; hint?: string }) { return <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60"><div className="text-[10px] text-muted">{label}</div><div className="mt-1 text-lg font-bold">{value}</div>{hint && <div className="text-[9px] text-muted">{hint}</div>}</div>; }
function MiniTrend({ label, points, color, format }: { label: string; points: Array<{ timestamp: string; value: number }>; color: "indigo" | "emerald"; format: (value: number) => string }) { const unit = label.includes("CPU") ? "cores" : "bytes"; return <div><div className="mb-1 flex justify-between text-[10px] text-muted"><span>{label}</span><span>{points.length ? format(points.at(-1)!.value) : "—"}</span></div><div className="rounded-lg bg-slate-50 dark:bg-slate-900/60"><InteractiveLineChart height={120} series={[{ name: label, points, color: color === "indigo" ? "#6366f1" : "#10b981", unit }]} /></div></div>; }
function AlertNotificationSettings() { const config = useAlertNotificationConfig(true); const [enabled, setEnabled] = useState(false); const [url, setUrl] = useState(""); const [secret, setSecret] = useState(""); useEffect(() => { if (!config.query.data) return; setEnabled(config.query.data.enabled); setUrl(config.query.data.url || ""); }, [config.query.data]); return <section className="card mt-4 p-5"><Title title="告警通知配置" subtitle="仅平台管理员可见；地址和签名密钥使用 AES-256-GCM 加密保存" /><div className="mt-4 grid gap-3 lg:grid-cols-[auto_1fr_1fr_auto_auto]"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />启用</label><input className="input h-10" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://alerts.example.com/webhook" /><input className="input h-10" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={config.query.data?.secretConfigured ? "已配置，留空保持不变" : "可选签名密钥"} /><button className="btn btn-primary" disabled={config.save.isPending} onClick={() => config.save.mutate({ enabled, url, secret: secret || undefined })}>保存</button><button className="btn btn-secondary" disabled={config.test.isPending || !config.query.data?.enabled} onClick={() => config.test.mutate()}>发送测试</button></div><div className="mt-2 text-[10px] text-muted">配置来源：{config.query.data?.source === "database" ? "平台数据库" : "环境变量回退"}{config.save.isSuccess ? " · 已保存" : ""}{config.test.isSuccess ? " · 测试发送成功" : ""}{config.test.error ? ` · 测试失败：${String(config.test.error)}` : ""}</div></section>; }
function UsageBar({ label, used, limit, suffix }: { label: string; used?: number; limit?: number; suffix: string }) { const percent = used === undefined || !limit ? 0 : Math.min(100, used / limit * 100); return <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800"><div className="flex justify-between text-xs"><span className="font-semibold text-muted">{label}</span><span>{used ?? "—"} / {limit ?? "—"}</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className={`h-full rounded-full ${percent >= 90 ? "bg-red-500" : percent >= 70 ? "bg-amber-500" : "bg-indigo-500"}`} style={{ width: `${percent}%` }} /></div><div className="mt-2 text-[10px] text-muted">{suffix} · {percent.toFixed(0)}%</div></div>; }
function Trend({ points }: { points: Array<{ time: string; total: number; successRate: number }> }) { if (!points.some((p) => p.total)) return <Empty />; return <div className="mt-4"><InteractiveLineChart height={240} series={[{ name: "请求量", color: "#818cf8", points: points.map((point) => ({ timestamp: point.time, value: point.total })) }, { name: "成功率", color: "#10b981", unit: "percent", yAxisIndex: 1, points: points.map((point) => ({ timestamp: point.time, value: point.successRate })) }]} /></div>; }
function fmt(value?: number) { return value === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(value); }
function ms(value?: number) { if (value === undefined) return "—"; return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(0)} ms`; }
function deliveryLabel(status: string) { return status === "sent" ? "Webhook 已发送" : status === "failed" ? "Webhook 失败" : status === "in_app" ? "站内通知" : "等待通知"; }
function bytes(value: number) { if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`; if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`; return `${(value / 1024).toFixed(1)} KiB`; }
function rate(value?: number | null) { return value == null ? "—" : `${bytes(value)}/s`; }
function serviceLabel(value: string) { return value === "api" ? "API 服务" : value === "worker" ? "后台 Worker" : value; }
