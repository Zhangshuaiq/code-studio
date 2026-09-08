import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "../../lib/api";
import { Select } from "../common/Select";

interface Endpoint {
  method: string;
  path: string;
}
interface ProxyResponse {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: string;
  ms: number;
  size: number;
}
interface HeaderRow {
  key: string;
  value: string;
}

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const METHOD_COLOR: Record<string, string> = {
  GET: "text-emerald-600 dark:text-emerald-400",
  POST: "text-amber-600 dark:text-amber-400",
  PUT: "text-blue-600 dark:text-blue-400",
  DELETE: "text-red-600 dark:text-red-400",
  PATCH: "text-purple-600 dark:text-purple-400",
};

function fmtSize(n: number): string {
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}

// 后端 API 在线调试（类 Swagger/Postman）：端点列表 + 自定义 Header + 响应详情，经后端代理避跨域
export function ApiTester({ sessionId }: { sessionId: string }) {
  const endpoints = useQuery<Endpoint[]>({
    queryKey: ["endpoints", sessionId],
    queryFn: async () =>
      (await api.get(`/preview/sessions/${sessionId}/endpoints`)).data,
  });

  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [body, setBody] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([{ key: "", value: "" }]);
  const [reqTab, setReqTab] = useState<"body" | "headers">("body");
  const [resTab, setResTab] = useState<"body" | "headers">("body");
  const [resp, setResp] = useState<ProxyResponse | null>(null);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);

  const noBody = method === "GET" || method === "HEAD";
  const headerCount = headers.filter((h) => h.key.trim()).length;

  function setHeader(i: number, patch: Partial<HeaderRow>) {
    setHeaders((rows) => {
      const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      // 最后一行填了 key 就自动补一个空行
      if (i === rows.length - 1 && (patch.key || patch.value))
        next.push({ key: "", value: "" });
      return next;
    });
  }
  function removeHeader(i: number) {
    setHeaders((rows) => rows.filter((_, idx) => idx !== i));
  }

  async function send() {
    setSending(true);
    setErr("");
    setResp(null);
    try {
      const h: Record<string, string> = {};
      for (const row of headers)
        if (row.key.trim()) h[row.key.trim()] = row.value;
      const r = await api.post(`/preview/sessions/${sessionId}/request`, {
        method,
        path,
        headers: h,
        body: noBody ? undefined : body || undefined,
      });
      setResp(r.data);
      setResTab("body");
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? String(e));
    } finally {
      setSending(false);
    }
  }

  const prettyBody = (() => {
    if (!resp) return "";
    if (resp.contentType.includes("json")) {
      try {
        return JSON.stringify(JSON.parse(resp.body), null, 2);
      } catch {
        /* fallthrough */
      }
    }
    return resp.body;
  })();

  return (
    <div className="flex h-full min-h-0 bg-white dark:bg-slate-900">
      {/* 端点列表 */}
      <aside className="w-52 shrink-0 overflow-y-auto border-r border-slate-200 dark:border-slate-800">
        <div className="border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted dark:border-slate-800">
          接口{endpoints.data?.length ? ` (${endpoints.data.length})` : ""}
        </div>
        {endpoints.isLoading ? (
          <p className="px-3 py-2 text-xs text-muted">解析中…</p>
        ) : !endpoints.data?.length ? (
          <p className="px-3 py-2 text-xs text-muted">
            未解析到接口，可手动输入路径调试。
          </p>
        ) : (
          <ul className="py-1">
            {endpoints.data.map((e, i) => (
              <li key={i}>
                <button
                  onClick={() => {
                    setMethod(e.method);
                    setPath(e.path);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <span
                    className={`w-12 shrink-0 font-mono font-semibold ${METHOD_COLOR[e.method] ?? ""}`}
                  >
                    {e.method}
                  </span>
                  <span className="truncate text-slate-600 dark:text-slate-300">
                    {e.path}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* 请求 + 响应 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 地址行 */}
        <div className="flex items-center gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
          <Select
            value={method}
            onChange={setMethod}
            options={METHODS.map((item) => ({ value: item, label: item }))}
            size="sm"
            className="w-24 shrink-0"
            buttonClassName={`font-semibold ${METHOD_COLOR[method] ?? ""}`}
            ariaLabel="请求方法"
          />
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="/api/..."
            className="input flex-1"
          />
          <button
            onClick={send}
            disabled={sending || !path}
            className="btn btn-primary btn-sm shrink-0"
          >
            {sending ? "发送中…" : "发送"}
          </button>
        </div>

        {/* 请求编辑：Body / Headers */}
        <div className="flex items-center gap-1 border-b border-slate-200 px-3 pt-1 text-xs dark:border-slate-800">
          {(["body", "headers"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setReqTab(t)}
              className={`rounded-t px-2.5 py-1 ${
                reqTab === t
                  ? "bg-slate-100 font-medium text-slate-800 dark:bg-slate-800 dark:text-slate-100"
                  : "text-muted"
              }`}
            >
              {t === "body"
                ? "请求体"
                : `请求头${headerCount ? ` (${headerCount})` : ""}`}
            </button>
          ))}
        </div>
        <div className="max-h-[34%] overflow-auto border-b border-slate-200 dark:border-slate-800">
          {reqTab === "body" ? (
            noBody ? (
              <p className="p-3 text-xs text-muted">GET/HEAD 无请求体</p>
            ) : (
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder='{"title":"..."}'
                rows={4}
                className="w-full bg-slate-50 p-3 font-mono text-xs outline-none dark:bg-slate-900/40"
              />
            )
          ) : (
            <div className="p-2">
              {headers.map((h, i) => (
                <div key={i} className="mb-1 flex items-center gap-1">
                  <input
                    value={h.key}
                    onChange={(e) => setHeader(i, { key: e.target.value })}
                    placeholder="Header 名，如 Authorization"
                    className="input flex-1 py-1 text-xs"
                  />
                  <input
                    value={h.value}
                    onChange={(e) => setHeader(i, { value: e.target.value })}
                    placeholder="值，如 Bearer xxx"
                    className="input flex-1 py-1 text-xs"
                  />
                  <button
                    onClick={() => removeHeader(i)}
                    className="px-1.5 text-slate-400 hover:text-red-500"
                    title="删除"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 响应 */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {err ? (
            <div className="p-3 text-sm text-red-500">{err}</div>
          ) : !resp ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              选择接口或输入路径，点「发送」调试
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-3 border-b border-slate-200 px-3 py-2 text-xs dark:border-slate-800">
                <span
                  className={`font-semibold ${
                    resp.status < 300
                      ? "text-emerald-600 dark:text-emerald-400"
                      : resp.status < 500
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-red-500"
                  }`}
                >
                  {resp.status}
                </span>
                <span className="text-muted">{resp.ms}ms</span>
                <span className="text-muted">{fmtSize(resp.size)}</span>
                <div className="ml-auto flex gap-1">
                  {(["body", "headers"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setResTab(t)}
                      className={`rounded px-2 py-0.5 ${
                        resTab === t ? "bg-indigo-600 text-white" : "text-muted"
                      }`}
                    >
                      {t === "body"
                        ? "响应体"
                        : `响应头 (${Object.keys(resp.headers).length})`}
                    </button>
                  ))}
                </div>
              </div>
              {resTab === "body" ? (
                <pre className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700 dark:bg-slate-950 dark:text-slate-200">
                  {prettyBody}
                </pre>
              ) : (
                <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs">
                  {Object.entries(resp.headers).map(([k, v]) => (
                    <div key={k} className="flex gap-2 py-0.5">
                      <span className="shrink-0 text-slate-500 dark:text-slate-400">
                        {k}:
                      </span>
                      <span className="break-all text-slate-700 dark:text-slate-200">
                        {v}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
