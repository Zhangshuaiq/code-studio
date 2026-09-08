import { Activity, Box, Database, Gauge, RefreshCw, Timer, Waypoints, Workflow } from 'lucide-react';
import { DependencyHealth, usePlatformHealth } from '../../hooks/usePlatformHealth';

const dependencies = [
  ['database', 'PostgreSQL', Database, '项目、任务和平台配置'],
  ['redis', 'Redis / BullMQ', Workflow, '生成任务排队与执行'],
  ['openSearch', 'OpenSearch', Activity, '业务日志与接口指标'],
  ['generationExecutor', '生成执行器', Box, '沙箱、预览与生成任务执行'],
  ['tempo', 'Tempo', Waypoints, '分布式链路存储与查询'],
  ['prometheus', 'Prometheus', Gauge, 'CPU、内存与运行时指标'],
] as const;

export function PlatformHealthPage() {
  const health = usePlatformHealth();
  const data = health.data;
  const online = data ? Object.values(data.dependencies).filter((x) => x.available).length : 0;
  return <div className="h-full overflow-y-auto rounded-[22px] border border-white/80 bg-white/45 dark:border-slate-800/80 dark:bg-slate-950/25"><div className="page-shell max-w-[1400px]">
    <header className="mb-6 flex items-end justify-between gap-4"><div><div className="eyebrow">Platform Operations</div><h1 className="mt-1 text-2xl font-bold">平台健康</h1><p className="mt-1 text-sm text-muted">核心依赖、任务队列和当前 API 实例状态</p></div><button className="btn btn-primary" onClick={() => health.refetch()}><RefreshCw size={14} className={health.isFetching ? 'animate-spin' : ''} />刷新</button></header>
    <div className="grid gap-3 sm:grid-cols-4"><Summary label="总体状态" value={data ? statusLabel(data.status) : '检测中'} tone={data?.status === 'healthy' ? 'green' : data ? 'red' : 'indigo'} /><Summary label="可用依赖" value={`${online} / ${dependencies.length}`} tone={online === dependencies.length ? 'green' : 'red'} /><Summary label="API 运行时间" value={data ? duration(data.uptimeSeconds) : '—'} tone="indigo" /><Summary label="发布版本" value={data?.build?.version??'—'} tone="indigo" /></div>
    {data?.build&&<div className="mt-3 rounded-xl border p-3 font-mono text-[10px] text-muted dark:border-slate-800">Git {data.build.gitSha} · 构建 {data.build.builtAt} · 镜像 {data.build.image}</div>}
    {!!data?.operationalIssues?.length && <div className="mt-4 space-y-2">{data.operationalIssues.map((issue) => <div key={issue.code} className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{issue.message}，请前往管理后台的资源回收页面处理。</div>)}</div>}
    <div className="mt-5 grid gap-4 md:grid-cols-2">{dependencies.map(([key, label, Icon, description]) => <DependencyCard key={key} label={label} description={description} icon={<Icon size={18} />} health={data?.dependencies[key]} />)}</div>
    <div className="mt-4 flex items-center gap-2 text-xs text-muted"><Timer size={13} />每 15 秒自动刷新 · 最近检测 {data ? new Date(data.checkedAt).toLocaleString('zh-CN') : '—'}</div>
  </div></div>;
}

function Summary({ label, value, tone }: { label: string; value: string; tone: 'green' | 'red' | 'indigo' }) { const color = tone === 'green' ? 'text-emerald-600' : tone === 'red' ? 'text-red-500' : 'text-indigo-600'; return <div className="card p-5"><div className="text-xs text-muted">{label}</div><div className={`mt-2 text-2xl font-bold ${color}`}>{value}</div></div>; }
function DependencyCard({ label, description, icon, health }: { label: string; description: string; icon: React.ReactNode; health?: DependencyHealth }) { return <section className="card p-5"><div className="flex items-start justify-between"><div className="flex gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10">{icon}</span><div><h2 className="font-bold">{label}</h2><p className="mt-0.5 text-xs text-muted">{description}</p></div></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${health?.available ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10' : 'bg-red-50 text-red-600 dark:bg-red-500/10'}`}>{health ? health.available ? '正常' : '异常' : '检测中'}</span></div><div className="mt-5 grid grid-cols-2 gap-3"><Metric label="探测延迟" value={health?.latencyMs === undefined ? '—' : `${health.latencyMs} ms`} /><Metric label="状态" value={health?.available ? '可连接' : '不可连接'} /></div>{health?.error && <div className="mt-3 rounded-xl bg-red-50 p-3 text-xs text-red-600 dark:bg-red-950/30">{health.error}</div>}<Details health={health} /></section>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60"><div className="text-[10px] text-muted">{label}</div><div className="mt-1 font-semibold">{value}</div></div>; }
function Details({ health }: { health?: DependencyHealth }) { if (!health) return null; const queue = health.queue as Record<string, number> | undefined; if (queue) return <div className="mt-3 text-[10px] text-muted">队列：等待 {queue.waiting ?? 0} · 执行 {queue.active ?? 0} · 延迟 {queue.delayed ?? 0} · 失败 {queue.failed ?? 0}</div>; if (typeof health.containersRunning === 'number') return <div className="mt-3 text-[10px] text-muted">容器：运行 {String(health.containersRunning)} / 总计 {String(health.containers)} · 镜像 {String(health.images)}</div>; return null; }
function statusLabel(status: string) { return status === 'healthy' ? '全部正常' : status === 'degraded' ? '部分异常' : '不可用'; }
function duration(seconds: number) { const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds % 86400 / 3600); return days ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`; }
