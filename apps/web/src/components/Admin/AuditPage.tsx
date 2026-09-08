import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Search,
  RotateCcw,
  ChevronRight,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  AuditParams,
  useAuditSearch,
  useAuditFacets,
} from "../../hooks/useAudit";
import { PageHeader } from "../Settings/ui";
import { Select as SelectField } from "../common/Select";

const PAGE_SIZE = 20;

export function AuditPage() {
  const { data: facets } = useAuditFacets();

  const [q, setQ] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [result, setResult] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  // 文本框防抖，其它筛选即时
  const dq = useDebounced(q, 300);
  const dactor = useDebounced(actor, 300);

  const params: AuditParams = useMemo(
    () => ({
      q: dq || undefined,
      actor: dactor || undefined,
      action: action || undefined,
      resourceType: resourceType || undefined,
      result: result || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [dq, dactor, action, resourceType, result, from, to, page],
  );

  // 任一筛选变化回到第 1 页
  useEffect(() => {
    setPage(1);
  }, [dq, dactor, action, resourceType, result, from, to]);

  const { data, isFetching } = useAuditSearch(params);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function reset() {
    setQ("");
    setActor("");
    setAction("");
    setResourceType("");
    setResult("");
    setFrom("");
    setTo("");
    setPage(1);
  }
  const hasFilter =
    q || actor || action || resourceType || result || from || to;

  return (
    <div>
      <PageHeader
        title="操作日志"
        desc="平台所有关键操作的审计留痕，支持全文检索与多维筛选。敏感字段（密码/私钥/token）已脱敏。"
      />

      {/* 检索栏 */}
      <div className="mb-4 space-y-2">
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="全文搜索：操作人 / 动作 / 资源 / 路径 / 详情…"
            className="input pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            placeholder="操作人"
            className="input h-8 w-32 text-xs"
          />
          <Select
            value={action}
            onChange={setAction}
            placeholder="动作"
            options={facets?.actions ?? []}
          />
          <Select
            value={resourceType}
            onChange={setResourceType}
            placeholder="资源类型"
            options={(facets?.resourceTypes ?? []) as string[]}
          />
          <Select
            value={result}
            onChange={setResult}
            placeholder="结果"
            options={["success", "failure"]}
          />
          <label className="flex items-center gap-1 text-[11px] text-muted">
            起
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="input h-8 text-xs"
            />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-muted">
            止
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="input h-8 text-xs"
            />
          </label>
          {hasFilter && (
            <button
              onClick={reset}
              className="btn btn-ghost btn-sm inline-flex items-center gap-1.5"
            >
              <RotateCcw size={13} /> 清空
            </button>
          )}
          <span className="ml-auto text-xs text-muted">
            共 {total} 条{isFetching ? " · 加载中…" : ""}
          </span>
        </div>
      </div>

      {/* 表 */}
      <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-muted dark:bg-slate-800/50">
            <tr>
              <th className="w-6 px-2 py-2"></th>
              <th className="px-3 py-2 font-medium">时间</th>
              <th className="px-3 py-2 font-medium">操作人</th>
              <th className="px-3 py-2 font-medium">动作</th>
              <th className="px-3 py-2 font-medium">资源</th>
              <th className="px-3 py-2 font-medium">结果</th>
              <th className="px-3 py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-muted">
                  无匹配记录
                </td>
              </tr>
            )}
            {items.map((it) => {
              const open = expanded === it.id;
              return (
                <Fragment key={it.id}>
                  <tr
                    onClick={() => setExpanded(open ? null : it.id)}
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
                  >
                    <td className="px-2 py-2 text-slate-400">
                      <ChevronRight
                        size={13}
                        className="transition-transform"
                        style={{ transform: open ? "rotate(90deg)" : "none" }}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">
                      {new Date(it.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-medium">{it.actorName}</td>
                    <td className="px-3 py-2">
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] dark:bg-slate-800">
                        {it.action}
                      </code>
                    </td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-muted">
                      {it.resourceType ? `${it.resourceType}` : "—"}
                      {it.resourceName
                        ? ` · ${it.resourceName}`
                        : it.resourceId
                          ? ` · ${it.resourceId.slice(0, 8)}`
                          : ""}
                    </td>
                    <td className="px-3 py-2">
                      {it.result === "failure" ? (
                        <span className="inline-flex items-center gap-1 text-red-500">
                          <XCircle size={13} /> 失败
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 size={13} /> 成功
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">{it.ip ?? "—"}</td>
                  </tr>
                  {open && (
                    <tr className="bg-slate-50/60 dark:bg-slate-900/40">
                      <td></td>
                      <td colSpan={6} className="px-3 pb-3">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] text-muted sm:grid-cols-3">
                          <Kv
                            k="method / path"
                            v={`${it.method ?? ""} ${it.path ?? ""}`}
                          />
                          <Kv k="statusCode" v={String(it.statusCode ?? "")} />
                          <Kv k="actorId" v={it.actorId ?? "—"} />
                        </div>
                        <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-200">
                          {JSON.stringify(it.detail ?? {}, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <div className="mt-3 flex items-center justify-between text-xs text-muted">
        <span>
          第 {data?.page ?? 1} / {totalPages} 页
        </span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="btn btn-ghost btn-sm"
          >
            上一页
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="btn btn-ghost btn-sm"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}

function Select({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: string[];
}) {
  return (
    <SelectField
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: `${placeholder}（全部）` },
        ...options.map((option) => ({ value: option, label: option })),
      ]}
      size="sm"
      className="min-w-32"
      ariaLabel={placeholder}
    />
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="truncate">
      <span className="text-slate-400">{k}: </span>
      <span className="text-slate-600 dark:text-slate-300">{v}</span>
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
