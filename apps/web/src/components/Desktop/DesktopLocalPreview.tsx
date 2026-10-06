import { useCallback, useEffect, useState } from "react";
import { ExternalLink, LoaderCircle, Play, RefreshCw, Square } from "lucide-react";
import { Select } from "../common/Select";

interface PreviewTarget { id: string; kind: string; label: string }
interface PreviewState { targets: PreviewTarget[]; scripts: string[]; targetId: string | null; targetLabel: string | null; script: string | null; port: number | null; url: string | null; status: string; logs: string[] }

export function DesktopLocalPreview({ projectId }: { projectId: string }) {
  const [state, setState] = useState<PreviewState>();
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/local/projects/${projectId}/preview`); const body = await response.json();
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      setState(body); setTargetId((current) => current && body.targets.some((item: PreviewTarget) => item.id === current) ? current : body.targetId || body.targets[0]?.id || "");
    } catch (reason: any) { setError(String(reason?.message || reason)); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!state || !["building", "starting", "running", "stopping"].includes(state.status)) return;
    const timer = window.setInterval(() => void load(), 1000); return () => window.clearInterval(timer);
  }, [state?.status, load]);
  async function start() {
    const target = state?.targets.find((item) => item.id === targetId);
    if (!target || !window.confirm(`即将启动“${target.label}”，是否继续？`)) return;
    setBusy(true); setError("");
    try { const response = await fetch(`/api/local/projects/${projectId}/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetId }) }); const body = await response.json(); if (!response.ok) throw new Error(body.message); setState((current) => ({ ...body, targets: current?.targets || [], scripts: current?.scripts || [] })); }
    catch (reason: any) { setError(String(reason?.message || reason)); } finally { setBusy(false); }
  }
  async function stop() { setBusy(true); try { await fetch(`/api/local/projects/${projectId}/preview`, { method: "DELETE" }); await load(); } finally { setBusy(false); } }
  const running = state && ["building", "starting", "running", "stopping"].includes(state.status);
  return <div className="flex h-full min-h-0 flex-col bg-slate-50 dark:bg-slate-950">
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-800"><Select className="w-full max-w-xs" size="sm" value={targetId} disabled={running} placeholder="未检测到可用启动配置" onChange={setTargetId} options={(state?.targets || []).map((item) => ({ value: item.id, label: item.label }))} />{running ? <button className="btn btn-secondary btn-sm" onClick={() => void stop()} disabled={busy}><Square size={12} />停止</button> : <button className="btn btn-primary btn-sm" onClick={() => void start()} disabled={busy || !targetId}>{busy ? <LoaderCircle size={12} className="animate-spin" /> : <Play size={12} />}启动预览</button>}<button className="icon-btn" onClick={() => void load()}><RefreshCw size={13} /></button><span className="text-[10px] text-slate-400">{state?.targetLabel || state?.status || "检测中"}{state?.port ? ` · 127.0.0.1:${state.port}` : ""}</span>{state?.url && <a className="ml-auto inline-flex items-center gap-1 text-xs text-indigo-500" href={state.url} target="_blank" rel="noreferrer"><ExternalLink size={12} />浏览器打开</a>}</div>
    {error && <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
    <div className="min-h-0 flex-1">{state?.url && running ? <iframe key={state.url} src={state.url} title="项目预览" className="h-full w-full border-0 bg-white" /> : <div className="grid h-full place-items-center px-8 text-center text-sm text-slate-400"><div><Play size={26} className="mx-auto mb-3" /><p className="font-semibold">项目预览</p><p className="mt-1 text-xs">选择启动配置后，在这里查看运行效果。</p></div></div>}</div>
    {state?.logs?.length ? <details className="shrink-0 border-t border-slate-200 bg-slate-950 text-slate-200 dark:border-slate-800"><summary className="cursor-pointer px-3 py-2 text-[10px]">预览日志（{state.logs.length}）</summary><pre className="max-h-40 overflow-auto px-3 pb-3 text-[10px] leading-4">{state.logs.join("\n")}</pre></details> : null}
  </div>;
}
