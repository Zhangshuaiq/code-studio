import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  Database,
  Gauge,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useProjects, Project } from "../../hooks/useProjects";
import { useMe } from "../../hooks/useMe";
import {
  BusinessLogItem,
  BusinessLogPolicy,
  BusinessLogSearch,
  BusinessLogSource,
  useBusinessLogHealth,
  useBusinessLogPolicy,
  useBusinessLogPolicyMutation,
  useBusinessLogSearch,
  useBusinessLogSourceMutations,
  useBusinessLogSources,
} from "../../hooks/useBusinessLogs";

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"];
const PRESETS = [
  { label: "15 分钟", minutes: 15 },
  { label: "1 小时", minutes: 60 },
  { label: "6 小时", minutes: 360 },
  { label: "24 小时", minutes: 1_440 },
  { label: "7 天", minutes: 10_080 },
];

export function BusinessLogsPage() {
  const [searchParams] = useSearchParams();
  const me = useMe();
  const projects = useProjects();
  const policy = useBusinessLogPolicy();
  const health = useBusinessLogHealth();
  const canRead = !!me.data?.permissions.includes("business-log:read");
  const canManageSources = !!me.data?.permissions.includes(
    "business-log:source-manage",
  );
  const canManagePolicy = !!me.data?.permissions.includes(
    "system-setting:manage",
  );
  const [projectId, setProjectId] = useState(() => searchParams.get("projectId") || "");
  const [from, setFrom] = useState(() =>
    localInput(new Date(Date.now() - 15 * 60_000)),
  );
  const [to, setTo] = useState(() => localInput(new Date()));
  const [environment, setEnvironment] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [query, setQuery] = useState("");
  const [traceId, setTraceId] = useState(() => searchParams.get("traceId") || "");
  const [levels, setLevels] = useState<string[]>([]);
  const [applied, setApplied] = useState<BusinessLogSearch | null>(null);
  const [sequence, setSequence] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);

  useEffect(() => {
    if (!projectId && projects.data?.length) {
      setProjectId(projects.data[0].id);
    }
  }, [projectId, projects.data]);

  useEffect(() => {
    if (!projectId || applied) return;
    const minutes = policy.data?.defaultQueryRangeMinutes ?? 15;
    const now = new Date();
    const nextFrom = localInput(new Date(now.getTime() - minutes * 60_000));
    const nextTo = localInput(now);
    setFrom(nextFrom);
    setTo(nextTo);
    setApplied({
      projectId,
      from: new Date(nextFrom).toISOString(),
      to: new Date(nextTo).toISOString(),
      traceId: traceId.trim() || undefined,
      limit: 200,
    });
  }, [projectId, policy.data, applied, traceId]);

  const search = useBusinessLogSearch(applied, sequence);
  const pages = search.data?.pages ?? [];
  const items = useMemo(() => pages.flatMap((page) => page.items), [pages]);
  const first = pages[0];

  function runSearch() {
    if (!projectId || !from || !to) return;
    setApplied({
      projectId,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      environment: environment || undefined,
      serviceName: serviceName || undefined,
      levels: levels.length ? levels : undefined,
      query: query.trim() || undefined,
      traceId: traceId.trim() || undefined,
      limit: 200,
    });
    setExpanded(null);
    setSequence((value) => value + 1);
  }

  function usePreset(minutes: number) {
    const now = new Date();
    setFrom(localInput(new Date(now.getTime() - minutes * 60_000)));
    setTo(localInput(now));
  }

  function toggleLevel(level: string) {
    setLevels((current) =>
      current.includes(level)
        ? current.filter((item) => item !== level)
        : [...current, level],
    );
  }

  if (!canRead && !me.isLoading) {
    return (
      <div className="card mx-auto mt-20 max-w-md px-8 py-12 text-center">
        <AlertTriangle className="mx-auto text-amber-500" size={32} />
        <p className="mt-4 font-bold">无权查询业务日志</p>
        <p className="mt-1 text-xs text-muted">
          请联系管理员授予业务日志查询权限。
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto rounded-[22px] border border-white/80 bg-white/45 backdrop-blur-sm dark:border-slate-800/80 dark:bg-slate-950/25">
      <div className="page-shell max-w-[1600px]">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="eyebrow">Observability</div>
            <div className="mt-1.5 flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20">
                <Activity size={21} />
              </span>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-slate-950 dark:text-white">
                  业务日志
                </h1>
                <p className="mt-0.5 text-sm text-muted">
                  按项目隔离的高性能日志检索，数据由 OpenSearch 提供。
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canManageSources && (
              <button
                onClick={() => setSourceOpen(true)}
                className="btn btn-ghost btn-sm"
              >
                <Plug size={14} /> 接入管理
              </button>
            )}
            {canManagePolicy && (
              <button
                onClick={() => setPolicyOpen(true)}
                className="btn btn-ghost btn-sm"
              >
                <Settings size={14} /> 存储策略
              </button>
            )}
            <button
              onClick={runSearch}
              disabled={!projectId || search.isFetching}
              className="btn btn-primary btn-sm"
            >
              <RefreshCw
                size={14}
                className={search.isFetching ? "animate-spin" : ""}
              />
              刷新
            </button>
          </div>
        </header>

        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={<Server size={16} />}
            label="检索集群"
            value={
              health.data?.available
                ? health.data.status === "green"
                  ? "运行正常"
                  : "可用 · 有告警"
                : "连接不可用"
            }
            hint={
              health.data?.available
                ? `${health.data.indexCount ?? 0} 个索引 · ${health.data.latencyMs ?? 0} ms`
                : "等待 OpenSearch"
            }
            tone={health.data?.available ? "emerald" : "amber"}
          />
          <MetricCard
            icon={<Database size={16} />}
            label="命中日志"
            value={
              first
                ? `${first.totalRelation === "gte" ? "≥" : ""}${formatCount(first.total)}`
                : "—"
            }
            hint={`当前已加载 ${formatCount(items.length)} 条`}
          />
          <MetricCard
            icon={<Gauge size={16} />}
            label="查询耗时"
            value={first ? `${first.tookMs} ms` : "—"}
            hint={
              first?.timedOut
                ? "查询已超时，结果可能不完整"
                : "OpenSearch 执行耗时"
            }
            tone={first?.timedOut ? "amber" : "indigo"}
          />
          <MetricCard
            icon={<Clock size={16} />}
            label="保留周期"
            value={`${policy.data?.retentionDays ?? 30} 天`}
            hint={`单次最多查询 ${policy.data?.maxQueryRangeHours ?? 168} 小时`}
          />
        </div>

        <section className="card mb-4 overflow-hidden">
          <div className="border-b border-slate-200/70 p-4 dark:border-slate-800">
            <div className="grid gap-3 xl:grid-cols-[1.1fr_1fr_1fr_1.4fr_auto]">
              <SelectField
                label="项目"
                value={projectId}
                onChange={(value) => {
                  setProjectId(value);
                  setApplied(null);
                }}
                options={(projects.data ?? []).map((project) => ({
                  value: project.id,
                  label: project.name,
                }))}
              />
              <InputField
                label="环境"
                value={environment}
                onChange={setEnvironment}
                placeholder="全部环境"
                list="log-environments"
              />
              <InputField
                label="服务"
                value={serviceName}
                onChange={setServiceName}
                placeholder="全部服务"
                list="log-services"
              />
              <InputField
                label="Trace ID"
                value={traceId}
                onChange={setTraceId}
                placeholder="精确定位一次请求"
              />
              <button
                onClick={runSearch}
                disabled={!projectId || search.isFetching}
                className="btn btn-primary self-end"
              >
                <Search size={16} /> 查询
              </button>
            </div>
            <datalist id="log-environments">
              {(first?.facets.environments ?? []).map((item) => (
                <option key={item.value} value={item.value} />
              ))}
            </datalist>
            <datalist id="log-services">
              {(first?.facets.services ?? []).map((item) => (
                <option key={item.value} value={item.value} />
              ))}
            </datalist>

            <div className="mt-3 grid gap-3 xl:grid-cols-[1fr_1fr_1.6fr]">
              <InputField
                label="开始时间"
                type="datetime-local"
                value={from}
                onChange={setFrom}
              />
              <InputField
                label="结束时间"
                type="datetime-local"
                value={to}
                onChange={setTo}
              />
              <div>
                <label className="label mb-1.5">日志内容</label>
                <div className="relative">
                  <Search
                    size={15}
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && runSearch()}
                    placeholder="消息、异常堆栈、属性或 Logger…"
                    className="input pl-10"
                  />
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="mr-1 text-[11px] font-semibold text-muted">
                快捷范围
              </span>
              {PRESETS.map((preset) => (
                <button
                  key={preset.minutes}
                  onClick={() => usePreset(preset.minutes)}
                  className="rounded-lg border border-slate-200/80 bg-white/70 px-2.5 py-1.5 text-[11px] font-medium text-slate-500 transition hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-400"
                >
                  {preset.label}
                </button>
              ))}
              <span className="ml-3 mr-1 text-[11px] font-semibold text-muted">
                级别
              </span>
              {LEVELS.map((level) => (
                <button
                  key={level}
                  onClick={() => toggleLevel(level)}
                  className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition ${
                    levels.includes(level)
                      ? levelButton(level)
                      : "border-slate-200/80 bg-white/70 text-slate-400 dark:border-slate-700 dark:bg-slate-900/70"
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>
          <Timeline
            data={first?.timeline ?? []}
            loading={search.isFetching && !first}
          />
        </section>

        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200/70 px-4 py-3 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <Code2 size={15} className="text-indigo-500" />
              <span className="text-sm font-bold">日志流</span>
              {search.isFetching && (
                <span className="text-[11px] text-muted">正在检索…</span>
              )}
            </div>
            <span className="text-[11px] text-muted">
              UTC 存储 · 本地时间展示
            </span>
          </div>

          {!projectId && <EmptyLogs text="请选择一个项目后开始查询" />}
          {projectId && search.isLoading && <LogSkeleton />}
          {search.isError && (
            <EmptyLogs
              error
              text={apiError(
                search.error,
                "日志查询失败，请检查 OpenSearch 连接",
              )}
            />
          )}
          {!search.isLoading && !search.isError && items.length === 0 && (
            <EmptyLogs text="当前范围没有匹配日志，尝试扩大时间或清空过滤条件" />
          )}
          {items.length > 0 && (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {items.map((item) => (
                <LogRow
                  key={`${item.index}:${item.id}`}
                  item={item}
                  open={expanded === item.id}
                  onToggle={() =>
                    setExpanded(expanded === item.id ? null : item.id)
                  }
                />
              ))}
            </div>
          )}
          {search.hasNextPage && (
            <div className="border-t border-slate-200/70 p-3 text-center dark:border-slate-800">
              <button
                onClick={() => search.fetchNextPage()}
                disabled={search.isFetchingNextPage}
                className="btn btn-ghost btn-sm"
              >
                {search.isFetchingNextPage ? (
                  <RefreshCw size={13} className="animate-spin" />
                ) : (
                  <ChevronRight size={13} className="rotate-90" />
                )}
                {search.isFetchingNextPage ? "加载中…" : "加载更早日志"}
              </button>
            </div>
          )}
        </section>
      </div>

      {sourceOpen && (
        <SourceManager
          projects={projects.data ?? []}
          onClose={() => setSourceOpen(false)}
        />
      )}
      {policyOpen && policy.data && (
        <PolicyDialog
          policy={policy.data}
          onClose={() => setPolicyOpen(false)}
        />
      )}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  hint,
  tone = "indigo",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  tone?: "indigo" | "emerald" | "amber";
}) {
  const toneClass = {
    indigo:
      "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300",
    emerald:
      "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300",
    amber:
      "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300",
  }[tone];
  return (
    <div className="card flex items-center gap-3 px-4 py-3.5">
      <span
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${toneClass}`}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
          {label}
        </p>
        <p className="mt-0.5 truncate text-sm font-bold text-slate-800 dark:text-slate-100">
          {value}
        </p>
        <p className="truncate text-[10px] text-muted">{hint}</p>
      </div>
    </div>
  );
}

function Timeline({
  data,
  loading,
}: {
  data: Array<{ time: string; count: number }>;
  loading: boolean;
}) {
  const max = Math.max(1, ...data.map((item) => item.count));
  return (
    <div className="relative h-20 bg-gradient-to-b from-slate-50/70 to-white/30 px-4 pb-3 pt-2 dark:from-slate-950/30 dark:to-slate-900/10">
      <div className="mb-1 flex items-center justify-between text-[9px] font-medium uppercase tracking-wider text-slate-400">
        <span>日志分布</span>
        <span>
          {loading
            ? "查询中"
            : `峰值 ${max === 1 && data.every((x) => !x.count) ? 0 : max} 条`}
        </span>
      </div>
      <div className="flex h-12 items-end gap-px">
        {data.length === 0
          ? Array.from({ length: 48 }).map((_, index) => (
              <span
                key={index}
                className="flex-1 rounded-t-sm bg-slate-200/60 dark:bg-slate-800/60"
                style={{ height: `${12 + (index % 7) * 2}%` }}
              />
            ))
          : data.map((item) => (
              <span
                key={item.time}
                title={`${new Date(item.time).toLocaleString()} · ${item.count} 条`}
                className="min-w-px flex-1 rounded-t-sm bg-gradient-to-t from-indigo-500 to-violet-400 opacity-80 transition hover:opacity-100"
                style={{
                  height: `${Math.max(item.count ? 7 : 2, (item.count / max) * 100)}%`,
                }}
              />
            ))}
      </div>
    </div>
  );
}

function LogRow({
  item,
  open,
  onToggle,
}: {
  item: BusinessLogItem;
  open: boolean;
  onToggle: () => void;
}) {
  const color = levelColor(item.level);
  return (
    <article style={{ contentVisibility: "auto" }}>
      <button
        onClick={onToggle}
        className="group grid w-full grid-cols-[18px_116px_72px_minmax(100px,150px)_1fr] items-start gap-2 px-4 py-2.5 text-left transition hover:bg-slate-50/80 dark:hover:bg-slate-800/35"
      >
        <ChevronRight
          size={14}
          className={`mt-0.5 text-slate-400 transition ${open ? "rotate-90" : ""}`}
        />
        <span className="font-mono text-[10px] leading-5 text-slate-400">
          {formatTime(item["@timestamp"])}
        </span>
        <span
          className={`mt-0.5 w-fit rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-bold ${color}`}
        >
          {item.level}
        </span>
        <span
          className="truncate text-[11px] font-semibold leading-5 text-slate-600 dark:text-slate-300"
          title={item.service_name}
        >
          {item.service_name}
        </span>
        <span className="break-words font-mono text-[11px] leading-5 text-slate-700 group-hover:text-slate-950 dark:text-slate-300 dark:group-hover:text-white">
          {item.message}
        </span>
      </button>
      {open && (
        <div className="border-l-2 border-indigo-400 bg-slate-50/80 px-5 py-4 dark:bg-slate-950/35">
          <div className="grid gap-2 text-[11px] sm:grid-cols-2 xl:grid-cols-4">
            <Detail
              label="时间"
              value={new Date(item["@timestamp"]).toLocaleString()}
            />
            <Detail
              label="环境 / 来源"
              value={`${item.environment} · ${item.source_name}`}
            />
            <Detail
              label="Logger / 线程"
              value={`${item.logger || "—"} · ${item.thread || "—"}`}
            />
            <Detail
              label="Trace / Span"
              value={`${item.trace_id || "—"} · ${item.span_id || "—"}`}
            />
          </div>
          {item.stack_trace && (
            <pre className="mt-3 max-h-72 overflow-auto rounded-xl border border-red-200/70 bg-red-50/60 p-3 font-mono text-[11px] leading-5 text-red-800 dark:border-red-500/20 dark:bg-red-500/5 dark:text-red-200">
              {item.stack_trace}
            </pre>
          )}
          {item.attributes && Object.keys(item.attributes).length > 0 && (
            <pre className="mt-3 max-h-56 overflow-auto rounded-xl border border-slate-200 bg-white/80 p-3 font-mono text-[11px] leading-5 text-slate-600 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300">
              {JSON.stringify(item.attributes, null, 2)}
            </pre>
          )}
        </div>
      )}
    </article>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200/70 bg-white/70 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/50">
      <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-400">
        {label}
      </span>
      <span
        className="mt-0.5 block truncate font-mono text-slate-600 dark:text-slate-300"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function SourceManager({
  projects,
  onClose,
}: {
  projects: Project[];
  onClose: () => void;
}) {
  const sources = useBusinessLogSources();
  const ops = useBusinessLogSourceMutations();
  const [showCreate, setShowCreate] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState("dev");
  const [serviceName, setServiceName] = useState("");
  const [format, setFormat] = useState<"json" | "log4j">("json");
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function create() {
    setError("");
    if (
      !projectId ||
      !name.trim() ||
      !environment.trim() ||
      !serviceName.trim()
    ) {
      setError("请完整填写项目、名称、环境和服务名");
      return;
    }
    try {
      const result = await ops.create.mutateAsync({
        projectId,
        name: name.trim(),
        environment: environment.trim(),
        serviceName: serviceName.trim(),
        format,
      });
      setToken(result.token);
      setShowCreate(false);
      setName("");
      setServiceName("");
    } catch (e) {
      setError(apiError(e, "创建日志源失败"));
    }
  }

  async function rotate(id: string) {
    try {
      const result = await ops.rotate.mutateAsync(id);
      setToken(result.token);
    } catch (e) {
      setError(apiError(e, "轮换 Token 失败"));
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  const endpoint = `${window.location.origin}/api/business-logs/ingest`;
  return (
    <Modal
      title="日志接入管理"
      desc="为每个项目服务签发独立 Token，平台自动注入项目和环境标签。"
      onClose={onClose}
      wide
    >
      {token && (
        <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 dark:border-emerald-500/25 dark:bg-emerald-500/10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold text-emerald-800 dark:text-emerald-200">
                请立即保存新的接入 Token
              </p>
              <p className="mt-0.5 text-[11px] text-emerald-700/70 dark:text-emerald-300/70">
                关闭后无法再次查看，只能重新轮换。
              </p>
            </div>
            <button
              onClick={() => copy(token)}
              className="btn btn-ghost btn-sm"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <code className="mt-3 block break-all rounded-xl bg-white/80 px-3 py-2 font-mono text-[11px] text-emerald-800 dark:bg-slate-950/40 dark:text-emerald-200">
            {token}
          </code>
          <details className="mt-3 text-[11px] text-emerald-800 dark:text-emerald-200">
            <summary className="cursor-pointer font-semibold">
              查看 HTTP 接入示例
            </summary>
            <pre className="mt-2 overflow-auto rounded-xl bg-slate-950 p-3 font-mono leading-5 text-slate-200">{`curl '${endpoint}' \\
  -H 'Authorization: Bearer ${token}' \\
  -H 'Content-Type: application/json' \\
  -d '{"logs":[{"timestamp":"${new Date().toISOString()}","level":"INFO","message":"service started"}]}'`}</pre>
          </details>
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <div className="text-[11px] text-muted">
          批量接口：
          <code className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">
            POST /api/business-logs/ingest
          </code>
        </div>
        <button
          onClick={() => setShowCreate((value) => !value)}
          className="btn btn-primary btn-sm"
        >
          {showCreate ? <X size={13} /> : <Plus size={13} />}
          {showCreate ? "取消" : "新建接入源"}
        </button>
      </div>

      {showCreate && (
        <div className="surface-soft mb-4 grid gap-3 p-4 sm:grid-cols-2">
          <SelectField
            label="项目"
            value={projectId}
            onChange={setProjectId}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
          />
          <InputField
            label="接入源名称"
            value={name}
            onChange={setName}
            placeholder="如订单服务生产日志"
          />
          <InputField
            label="环境"
            value={environment}
            onChange={setEnvironment}
            placeholder="dev / test / prod"
          />
          <InputField
            label="服务名"
            value={serviceName}
            onChange={setServiceName}
            placeholder="order-service"
          />
          <SelectField
            label="日志格式"
            value={format}
            onChange={(value) => setFormat(value as "json" | "log4j")}
            options={[
              { value: "json", label: "JSON 结构化日志" },
              { value: "log4j", label: "Log4j 文本日志" },
            ]}
          />
          <button
            onClick={create}
            disabled={ops.create.isPending}
            className="btn btn-primary self-end"
          >
            {ops.create.isPending ? "创建中…" : "创建并签发 Token"}
          </button>
        </div>
      )}
      {error && (
        <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="space-y-2">
        {sources.isLoading && (
          <div className="surface-soft p-8 text-center text-xs text-muted">
            加载接入源…
          </div>
        )}
        {(sources.data ?? []).map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            busy={
              ops.update.isPending ||
              ops.remove.isPending ||
              ops.rotate.isPending
            }
            confirmDelete={confirmDelete === source.id}
            onToggle={() =>
              ops.update.mutate({
                id: source.id,
                status: source.status === "active" ? "disabled" : "active",
              })
            }
            onRotate={() => rotate(source.id)}
            onDelete={() => {
              if (confirmDelete === source.id) {
                ops.remove.mutate(source.id);
                setConfirmDelete(null);
              } else setConfirmDelete(source.id);
            }}
            onCancelDelete={() => setConfirmDelete(null)}
          />
        ))}
        {!sources.isLoading && !sources.data?.length && (
          <div className="surface-soft p-10 text-center text-sm text-muted">
            暂无日志接入源
          </div>
        )}
      </div>
    </Modal>
  );
}

function SourceRow({
  source,
  busy,
  confirmDelete,
  onToggle,
  onRotate,
  onDelete,
  onCancelDelete,
}: {
  source: BusinessLogSource;
  busy: boolean;
  confirmDelete: boolean;
  onToggle: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200/80 bg-white/80 p-3.5 dark:border-slate-800 dark:bg-slate-900/70">
      <span
        className={`grid h-10 w-10 place-items-center rounded-xl ${source.status === "active" ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-slate-100 text-slate-400 dark:bg-slate-800"}`}
      >
        <Plug size={16} />
      </span>
      <div className="min-w-[180px] flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-bold">{source.name}</span>
          <span className="status-pill py-0 text-[9px]">
            {source.status === "active" ? "接收中" : "已停用"}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted">
          {source.project?.name} · {source.environment} · {source.serviceName} ·{" "}
          {source.format.toUpperCase()}
        </p>
        <p className="mt-0.5 text-[10px] text-slate-400">
          Token {source.tokenPrefix}… · 最近写入{" "}
          {source.lastIngestedAt
            ? new Date(source.lastIngestedAt).toLocaleString()
            : "暂无"}
        </p>
      </div>
      {confirmDelete ? (
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-red-500">确认删除？</span>
          <button
            onClick={onDelete}
            disabled={busy}
            className="btn btn-sm border border-red-200 bg-red-50 text-red-600 dark:border-red-500/20 dark:bg-red-500/10"
          >
            确认
          </button>
          <button onClick={onCancelDelete} className="btn btn-ghost btn-sm">
            取消
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button
            onClick={onToggle}
            disabled={busy}
            title={source.status === "active" ? "停用" : "启用"}
            className="icon-btn h-8 w-8 rounded-lg"
          >
            {source.status === "active" ? (
              <Pause size={14} />
            ) : (
              <Play size={14} />
            )}
          </button>
          <button
            onClick={onRotate}
            disabled={busy}
            title="轮换 Token"
            className="icon-btn h-8 w-8 rounded-lg"
          >
            <RotateCw size={14} />
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            title="删除接入源"
            className="icon-btn h-8 w-8 rounded-lg hover:text-red-500"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function PolicyDialog({
  policy,
  onClose,
}: {
  policy: BusinessLogPolicy;
  onClose: () => void;
}) {
  const mutation = useBusinessLogPolicyMutation();
  const [value, setValue] = useState(policy);
  const [error, setError] = useState("");
  async function save() {
    setError("");
    try {
      await mutation.mutateAsync(value);
      onClose();
    } catch (e) {
      setError(apiError(e, "保存存储策略失败"));
    }
  }
  const number = (key: keyof BusinessLogPolicy, input: string) =>
    setValue((current) => ({ ...current, [key]: Number(input) }));
  return (
    <Modal
      title="业务日志存储策略"
      desc="配置由平台保存并执行，OpenSearch 不向终端用户暴露。缩短周期会立即清理过期的整日索引。"
      onClose={onClose}
    >
      <div className="mb-4 rounded-2xl border border-indigo-200 bg-indigo-50/70 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/10">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-600 text-white">
            <Database size={17} />
          </span>
          <div>
            <p className="text-sm font-bold text-indigo-900 dark:text-indigo-100">
              默认保留 {value.retentionDays} 天
            </p>
            <p className="text-[11px] text-indigo-700/70 dark:text-indigo-300/70">
              按 UTC 每日索引清理，避免大规模逐条删除影响查询。
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <NumberField
          label="日志保留天数"
          value={value.retentionDays}
          min={1}
          max={3650}
          onChange={(v) => number("retentionDays", v)}
        />
        <NumberField
          label="默认查询范围（分钟）"
          value={value.defaultQueryRangeMinutes}
          min={5}
          max={1440}
          onChange={(v) => number("defaultQueryRangeMinutes", v)}
        />
        <NumberField
          label="单次最大范围（小时）"
          value={value.maxQueryRangeHours}
          min={1}
          max={720}
          onChange={(v) => number("maxQueryRangeHours", v)}
        />
        <NumberField
          label="单次最大返回条数"
          value={value.maxResultLines}
          min={100}
          max={10000}
          onChange={(v) => number("maxResultLines", v)}
        />
        <NumberField
          label="查询超时（秒）"
          value={value.queryTimeoutSeconds}
          min={3}
          max={120}
          onChange={(v) => number("queryTimeoutSeconds", v)}
        />
      </div>
      {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="btn btn-ghost">
          取消
        </button>
        <button
          onClick={save}
          disabled={mutation.isPending}
          className="btn btn-primary"
        >
          {mutation.isPending ? "保存并应用…" : "保存并应用"}
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  desc,
  onClose,
  wide,
  children,
}: {
  title: string;
  desc: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-sm"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={`card max-h-[88vh] w-full overflow-hidden ${wide ? "max-w-4xl" : "max-w-2xl"}`}
      >
        <div className="flex items-start justify-between border-b border-slate-200/70 px-5 py-4 dark:border-slate-800">
          <div>
            <h2 className="text-base font-bold">{title}</h2>
            <p className="mt-1 text-xs text-muted">{desc}</p>
          </div>
          <button onClick={onClose} className="icon-btn">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[calc(88vh-86px)] overflow-y-auto p-5">
          {children}
        </div>
      </div>
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  list,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  list?: string;
}) {
  return (
    <div>
      <label className="label mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        list={list}
        className="input"
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="label mb-1.5">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="input"
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <label className="label mb-1.5">{label}</label>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="input"
      >
        <option value="">请选择</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function EmptyLogs({ text, error }: { text: string; error?: boolean }) {
  return (
    <div
      className={`px-5 py-20 text-center text-sm ${error ? "text-red-500" : "text-muted"}`}
    >
      {error ? (
        <AlertTriangle size={24} className="mx-auto mb-3" />
      ) : (
        <Activity
          size={24}
          className="mx-auto mb-3 text-slate-300 dark:text-slate-700"
        />
      )}
      {text}
    </div>
  );
}

function LogSkeleton() {
  return (
    <div className="space-y-0 divide-y divide-slate-100 p-2 dark:divide-slate-800">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex animate-pulse gap-4 px-3 py-3">
          <span className="h-3 w-24 rounded bg-slate-200 dark:bg-slate-800" />
          <span className="h-3 w-12 rounded bg-slate-200 dark:bg-slate-800" />
          <span className="h-3 flex-1 rounded bg-slate-100 dark:bg-slate-800/60" />
        </div>
      ))}
    </div>
  );
}

function localInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatTime(value: string) {
  const date = new Date(value);
  return `${date.toLocaleTimeString(undefined, { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function formatCount(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function levelColor(level: string) {
  if (level === "ERROR" || level === "FATAL")
    return "border-red-200 bg-red-50 text-red-600 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300";
  if (level === "WARN")
    return "border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300";
  if (level === "DEBUG" || level === "TRACE")
    return "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400";
  return "border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-blue-300";
}

function levelButton(level: string) {
  return levelColor(level)
    .replace("bg-red-50", "bg-red-100")
    .replace("bg-amber-50", "bg-amber-100")
    .replace("bg-blue-50", "bg-blue-100");
}

function apiError(error: unknown, fallback: string) {
  const value = error as {
    response?: { data?: { message?: string | string[] } };
    message?: string;
  };
  const message = value?.response?.data?.message;
  return Array.isArray(message)
    ? message.join("，")
    : message || value?.message || fallback;
}
