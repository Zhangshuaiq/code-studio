import { useCallback, useEffect, useRef, useState } from "react";
import { Bug, Play, Square, Pause, StepForward, ArrowDownToLine, ArrowUpFromLine, RefreshCw, Settings2, X } from "lucide-react";
import { Select } from "../common/Select";

type Target = { mainClass: string; projectName?: string; label: string };
type Frame = { id: number; name: string; path?: string; line: number; column: number };
type RunState = { sessionId?: string; stopVersion?: number; framesLoading?: boolean; framesError?: string; status: string; mode?: string; mainClass?: string; logs: string[]; frames: Frame[]; issues?: { path: string; line: number; column: number; message: string }[]; reason?: string; breakpoints?: { path: string; line: number; verified: boolean; message?: string }[] };
type Variable = { name: string; value: string; type?: string; variablesReference: number };
export function useDesktopJavaRun(projectId: string, enabled: boolean, active: boolean, hasUnsaved: boolean, onLocate: (frame: Frame) => void) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [selected, setSelected] = useState("");
  const [state, setState] = useState<RunState>({ status: "idle", logs: [], frames: [] });
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>({});
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [inspectionSelection, setInspectionSelection] = useState<{ pauseKey: string; id: number }>();
  const [configure, setConfigure] = useState(false);
  const [args, setArgs] = useState("");
  const [vmArgs, setVmArgs] = useState("");
  const locate = useRef(onLocate); locate.current = onLocate;
  const previousFrame = useRef("");
  const pointsRef = useRef(breakpoints); pointsRef.current = breakpoints;
  const stateRef = useRef(state); stateRef.current = state;
  const requestEpoch = useRef(0);
  const actionPending = useRef(false);
  const paused = state.status === "paused";
  const pauseKey = `${state.sessionId}:${state.stopVersion}`;
  const inspectionFrame = paused ? (inspectionSelection?.pauseKey === pauseKey ? state.frames.find((frame) => frame.id === inspectionSelection.id) : undefined) || state.frames.find((frame) => frame.path) || state.frames[0] : undefined;
  const base = `/api/local/projects/${projectId}/java-run`;
  const request = useCallback(async (action = "", input?: any) => {
    const response = await fetch(`${base}${action ? `/${action}` : ""}`, input === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const body = await response.json(); if (!response.ok) throw new Error(body.message || "运行操作失败"); return body;
  }, [base]);
  const inspectRequest = useCallback((action: string, input: any) => request(action, { ...input, sessionId: state.sessionId, stopVersion: state.stopVersion }), [request, state.sessionId, state.stopVersion]);
  async function loadTargets() {
    setLoading(true); setError("");
    try { const body = await request("targets"); setTargets(body.targets); setSelected((value) => body.targets.some((item: Target) => targetKey(item) === value) ? value : body.targets[0] ? targetKey(body.targets[0]) : ""); }
    catch (reason: any) { setError(reason.message); } finally { setLoading(false); }
  }
  useEffect(() => { if (enabled) void loadTargets(); }, [projectId, enabled]);
  useEffect(() => {
    if (!enabled || !active) return;
    let cancelled = false;
    let inFlight = false;
    async function poll() {
      if (inFlight || actionPending.current) return;
      inFlight = true; const epoch = requestEpoch.current;
      try { const body = await request(); if (!cancelled && epoch === requestEpoch.current && !actionPending.current) setState(body); } catch {} finally { inFlight = false; }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 700);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [request, enabled, active]);
  useEffect(() => {
    if (!active) { previousFrame.current = ""; return; }
    const frame = inspectionFrame; const key = frame ? `${pauseKey}:${frame.id}:${frame.path}:${frame.line}:${frame.column}` : "";
    if (key && key !== previousFrame.current) { setVisible(true); if (frame?.path) locate.current(frame); }
    previousFrame.current = key;
  }, [active, pauseKey, inspectionFrame]);
  async function action(name: string, input = {}) {
    if (actionPending.current) return;
    actionPending.current = true; requestEpoch.current++;
    setBusy(true); setError("");
    try { const body = await request(name, input); if (body.status) setState(body); }
    catch (reason: any) { setError(reason.message); setVisible(true); try { setState(await request()); } catch {} }
    finally { actionPending.current = false; setBusy(false); }
  }
  async function start(mode: "run" | "debug") {
    if (hasUnsaved) { setError("请先保存修改，再运行项目。"); setVisible(true); return; }
    const target = targets.find((item) => targetKey(item) === selected); if (!target) return;
    setVisible(true);
    await action("start", { mode, mainClass: target.mainClass, projectName: target.projectName, breakpoints: pointsRef.current, args, vmArgs });
  }
  const toggleBreakpoint = useRef<(file: string, line: number) => void>(() => {});
  toggleBreakpoint.current = (file, line) => {
    const current = pointsRef.current; const lines = current[file] || [];
    const next = { ...current, [file]: lines.includes(line) ? lines.filter((value) => value !== line) : [...lines, line].sort((a, b) => a - b) };
    pointsRef.current = next; setBreakpoints(next);
    if (stateRef.current.mode === "debug" && ["running", "paused"].includes(stateRef.current.status)) void action("breakpoints", { breakpoints: next });
  };
  const running = ["starting", "running", "paused"].includes(state.status);
  const toolbar = enabled ? <div className="flex items-center gap-1">
    <Select size="sm" className="w-52" value={selected} disabled={busy || running} placeholder={loading ? "加载运行配置…" : "无 Java main 入口"} options={targets.map((item) => ({ value: targetKey(item), label: item.label }))} onChange={setSelected} />
    <button className="icon-btn text-emerald-600" title="运行" disabled={busy || running || !selected} onClick={() => void start("run")}><Play size={15} /></button>
    <button className="icon-btn text-indigo-500" title="Debug" disabled={busy || running || !selected} onClick={() => void start("debug")}><Bug size={15} /></button>
    {running && <button className="icon-btn text-red-500" title="停止" disabled={busy} onClick={() => void action("stop")}><Square size={14} /></button>}
    <button className="icon-btn" title="刷新运行配置" disabled={busy || loading || running} onClick={() => void loadTargets()}><RefreshCw size={13} /></button>
    <button className="icon-btn" title="运行参数" disabled={running} onClick={() => { setConfigure(!configure); setVisible(true); }}><Settings2 size={13} /></button>
    <button className="icon-btn" title="运行 / 调试控制台" onClick={() => setVisible((value) => !value)}><span className="text-[10px]">{paused ? "暂停" : "控制台"}</span></button>
  </div> : null;
  const panel = visible && enabled ? <div className="flex h-56 shrink-0 flex-col border-t border-slate-200 bg-slate-50 text-xs dark:border-slate-700 dark:bg-slate-950">
    <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-1 dark:border-slate-800">
      <span>{state.mode === "debug" ? "Debug" : "运行"} · {({ idle: "就绪", starting: "启动中", running: "运行中", paused: "已暂停", stopped: "已结束", failed: "失败" } as Record<string, string>)[state.status]}</span>
      {state.mode === "debug" && running && <>
        <button className="icon-btn" title={paused ? "继续" : "暂停"} disabled={busy} onClick={() => void action(paused ? "continue" : "pause")}>{paused ? <Play size={14} /> : <Pause size={14} />}</button>
        <button className="icon-btn" title="单步跳过" disabled={!paused || busy} onClick={() => void action("next")}><StepForward size={14} /></button>
        <button className="icon-btn" title="单步进入" disabled={!paused || busy} onClick={() => void action("stepIn")}><ArrowDownToLine size={14} /></button>
        <button className="icon-btn" title="单步跳出" disabled={!paused || busy} onClick={() => void action("stepOut")}><ArrowUpFromLine size={14} /></button>
      </>}
      {running && <button className="icon-btn text-red-500" title="停止" disabled={busy} onClick={() => void action("stop")}><Square size={13} /></button>}
      <button className="icon-btn ml-auto" title="关闭面板" onClick={() => setVisible(false)}><X size={13} /></button>
    </div>
    {error && <p className="shrink-0 px-3 py-1 text-red-500">{error}</p>}
    {configure && <div className="flex shrink-0 gap-3 border-b border-slate-200 p-2 dark:border-slate-800"><label className="flex flex-1 items-center gap-2">程序参数<input className="input flex-1 text-xs" placeholder="--spring.profiles.active=dev" value={args} disabled={running} onChange={(event) => setArgs(event.target.value)} /></label><label className="flex flex-1 items-center gap-2">JVM 参数<input className="input flex-1 text-xs" placeholder="-Xmx1g -Dkey=value" value={vmArgs} disabled={running} onChange={(event) => setVmArgs(event.target.value)} /></label></div>}
    {state.breakpoints?.filter((point) => !point.verified).map((point) => <p key={`${point.path}:${point.line}`} className="px-3 text-amber-600">断点 {point.path}:{point.line} · {point.message || "尚未绑定"}</p>)}
    <div className="flex min-h-0 flex-1">
      {state.issues?.length ? <div className="w-1/2 overflow-auto border-r border-slate-200 p-2 dark:border-slate-800"><p className="mb-1 text-slate-400">编译问题（{state.issues.length}）</p>{state.issues.map((issue, index) => <button key={index} className="block w-full rounded p-1 text-left text-red-500 hover:bg-slate-200 dark:hover:bg-slate-800" title={issue.message} onClick={() => locate.current({ id: 0, name: issue.message, path: issue.path, line: issue.line, column: issue.column })}><span className="block font-mono text-[10px]">{issue.path}:{issue.line}</span>{issue.message}</button>)}</div> : null}
      {paused && <div className="w-1/3 overflow-auto border-r border-slate-200 p-2 dark:border-slate-800"><p className="mb-1 text-slate-400">调用栈</p>{state.framesLoading && <p>加载调用栈…</p>}{state.framesError && <p className="text-red-500">{state.framesError}</p>}{state.frames.map((frame) => <button key={frame.id} className={`block w-full truncate rounded p-1 text-left hover:bg-slate-200 dark:hover:bg-slate-800 ${inspectionFrame?.id === frame.id ? "bg-indigo-100 text-indigo-600 dark:bg-indigo-950" : ""}`} onClick={() => setInspectionSelection({ pauseKey, id: frame.id })}>{frame.name}:{frame.line}</button>)}</div>}
      {paused && <DebugVariables key={`${pauseKey}:${inspectionFrame?.id}`} frame={inspectionFrame} request={inspectRequest} />}
      <pre className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px]">{state.logs.join("") || "点击编辑器行号左侧可设置断点。"}</pre>
    </div>
  </div> : null;
  return { toolbar, panel, breakpoints, toggleBreakpoint, pausedFrame: inspectionFrame };
}
function targetKey(target: Target) { return JSON.stringify([target.mainClass, target.projectName]); }
function DebugVariables({ frame, request }: { frame?: Frame; request: (action: string, input: any) => Promise<any> }) {
  const [scopes, setScopes] = useState<{ name: string; variablesReference: number }[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { let cancelled = false; setScopes([]); setError(""); setLoading(Boolean(frame)); if (frame) void request("scopes", { frameId: frame.id }).then((body) => { if (!cancelled) setScopes(body.scopes || []); }).catch((error) => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [frame?.id, request]);
  return <div className="w-1/3 overflow-auto border-r border-slate-200 p-2 dark:border-slate-800"><p className="mb-1 text-slate-400">变量</p>{loading && <p>加载变量…</p>}{!frame && <p className="text-slate-400">等待调用栈…</p>}{error && <p className="text-red-500">{error}</p>}{!loading && frame && !error && !scopes.length && <p className="text-slate-400">该调用帧没有可读取的变量。</p>}{scopes.map((scope) => <VariableGroup key={scope.variablesReference} name={scope.name} reference={scope.variablesReference} request={request} initialOpen />)}</div>;
}
function VariableGroup({ name, reference, request, initialOpen = false }: { name: string; reference: number; request: (action: string, input: any) => Promise<any>; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [variables, setVariables] = useState<Variable[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { let cancelled = false; if (open) { setLoading(true); setError(""); void request("variables", { variablesReference: reference }).then((body) => { if (!cancelled) setVariables(body.variables || []); }).catch((error) => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setLoading(false); }); } return () => { cancelled = true; }; }, [open, reference, request]);
  return <div><button className="max-w-full truncate text-left" title={name} onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {name}</button>{open && <div className="pl-3">{loading && <p className="text-slate-400">加载中…</p>}{error && <p className="text-red-500">{error}</p>}{!loading && !error && !variables.length && <p className="text-slate-400">无可用变量</p>}{variables.map((variable, index) => variable.variablesReference > 0 ? <VariableGroup key={index} name={`${variable.name}: ${variable.value}`} reference={variable.variablesReference} request={request} /> : <p key={index} className="truncate" title={`${variable.type || ""} ${variable.value}`}>{variable.name}: {variable.value}</p>)}</div>}</div>;
}
