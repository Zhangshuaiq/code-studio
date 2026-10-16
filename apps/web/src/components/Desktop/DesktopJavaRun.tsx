import { useCallback, useEffect, useRef, useState } from "react";
import { Bug, Play, Square, Pause, StepForward, ArrowDownToLine, ArrowUpFromLine, RefreshCw, Settings2, X } from "lucide-react";
import { Select } from "../common/Select";
import { JavaRunConfigurationDialog } from './JavaRunConfigurationDialog';
import { isLanguageStartupError } from './DesktopLanguageStatus';
import { BreakpointEditHistory, BreakpointDiskCheckpoints, type SourceEdit } from '../../lib/breakpoint-migration';

type Target = { mainClass: string; projectName?: string; label: string };
type NamedConfiguration = { id: string; name: string; mainClass: string; projectName?: string; args: string; vmArgs: string; javaHome?: string };
type JavaEnvironment = { source: string; target: string; release: boolean; required: number; buildTool: string; selected: { home: string; version: string }; jdks: { home: string; version: string; major: number; vendor: string; arch: string }[] };
type Frame = { id: number; name: string; path?: string; line: number; column: number };
type RunState = { sessionId?: string; stopVersion?: number; framesLoading?: boolean; framesError?: string; threads?: { id: number; name: string }[]; threadId?: number; pausedThreadIds?: number[]; threadsTruncated?: boolean; status: string; mode?: string; mainClass?: string; logs: string[]; frames: Frame[]; issues?: { path: string; line: number; column: number; message: string }[]; reason?: string; breakpoints?: { path: string; line: number; verified: boolean; message?: string }[] };
type Variable = { name: string; value: string; type?: string; variablesReference: number };
type Breakpoint = number | { line: number; condition?: string; hitCondition?: string; logMessage?: string };
type Breakpoints = Record<string, Breakpoint[]>;
export const breakpointLine = (point: Breakpoint) => typeof point === 'number' ? point : point.line;
export const breakpointCondition = (point: Breakpoint) => typeof point === 'number' ? '' : point.condition || '';
export const breakpointHitCondition = (point: Breakpoint) => typeof point === 'number' ? '' : point.hitCondition || '';
export const breakpointLogMessage = (point: Breakpoint) => typeof point === 'number' ? '' : point.logMessage || '';
function togglePoint(current: Breakpoints, file: string, line: number) {
  const lines = current[file] || [];
  const next = { ...current, [file]: lines.some(point => breakpointLine(point) === line) ? lines.filter(point => breakpointLine(point) !== line) : [...lines, line].sort((a, b) => breakpointLine(a) - breakpointLine(b)) };
  if (!next[file].length) delete next[file];
  return next;
}
export function useDesktopJavaRun(projectId: string, enabled: boolean, active: boolean, hasUnsaved: boolean, onLocate: (frame: Frame) => void) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetsLoaded, setTargetsLoaded] = useState(false);
  const [selected, setSelected] = useState("");
  const [state, setState] = useState<RunState>({ status: "idle", logs: [], frames: [] });
  const targetDiscoveryStarted = useRef(false);
  const running = ["starting", "running", "paused"].includes(state.status);
  const [breakpoints, setBreakpoints] = useState<Breakpoints>({});
  const [conditionEditor, setConditionEditor] = useState<{ file: string; line: number; value: string; hit: string; log: string }>();
  const [breakpointsLoading, setBreakpointsLoading] = useState(true);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [inspectionSelection, setInspectionSelection] = useState<{ pauseKey: string; id: number }>();
  const [configure, setConfigure] = useState(false);
  const [args, setArgs] = useState("");
  const [vmArgs, setVmArgs] = useState("");
  const [javaHome, setJavaHome] = useState('');
  const [environment, setEnvironment] = useState<JavaEnvironment>();
  const [environmentError, setEnvironmentError] = useState('');
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [environmentRefresh, setEnvironmentRefresh] = useState(0);
  const [configurationNotice, setConfigurationNotice] = useState("");
  const [configurations, setConfigurations] = useState<NamedConfiguration[]>([]);
  const [configurationId, setConfigurationId] = useState('');
  const [configurationName, setConfigurationName] = useState('默认配置');
  const targetLoadVersion = useRef(0);
  const retryTargets = useRef(false);
  const locate = useRef(onLocate); locate.current = onLocate;
  const previousFrame = useRef("");
  const pointsRef = useRef(breakpoints); pointsRef.current = breakpoints;
  const breakpointEpoch = useRef(0);
  const breakpointReady = useRef(false);
  const pendingToggles = useRef<Array<{ file: string; line: number }>>([]);
  const breakpointWrites = useRef<Promise<void>>(Promise.resolve());
  const deferredBreakpointSave = useRef(false);
  const editHistory = useRef(new BreakpointEditHistory());
  const diskCheckpoints = useRef(new BreakpointDiskCheckpoints());
  const pathOperation = useRef(false);
  const unsavedRef = useRef(hasUnsaved); unsavedRef.current = hasUnsaved;
  const stateRef = useRef(state); stateRef.current = state;
  const requestEpoch = useRef(0);
  const actionPending = useRef(false);
  const pendingActionName = useRef('');
  const pendingBreakpointSync = useRef(false);
  const paused = state.status === "paused";
  const pauseKey = `${state.sessionId}:${state.stopVersion}`;
  const inspectionFrame = paused ? (inspectionSelection?.pauseKey === pauseKey ? state.frames.find((frame) => frame.id === inspectionSelection.id) : undefined) || state.frames.find((frame) => frame.path) || state.frames[0] : undefined;
  const base = `/api/local/projects/${projectId}/java-run`;
  const request = useCallback(async (action = "", input?: any) => {
    const response = await fetch(`${base}${action ? `/${action}` : ""}`, input === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const body = await response.json(); if (!response.ok) throw Object.assign(new Error(body.message || "运行操作失败"), { code: body.code }); return body;
  }, [base]);
  const inspectRequest = useCallback((action: string, input: any) => request(action, { ...input, sessionId: state.sessionId, stopVersion: state.stopVersion }), [request, state.sessionId, state.stopVersion]);
  const persistBreakpoints = useCallback((points: Breakpoints, epoch: number) => {
    if (unsavedRef.current) { deferredBreakpointSave.current = true; return; }
    diskCheckpoints.current.reset(points);
    // Serialize snapshots so a slower earlier save cannot overwrite the last click.
    breakpointWrites.current = breakpointWrites.current.catch(() => {}).then(async () => {
      try { await request('breakpoint-configuration', { breakpoints: points }); }
      catch (reason: any) { if (breakpointEpoch.current === epoch) { setError(`断点未保存：${reason.message}`); setVisible(true); } }
    });
  }, [request]);
  useEffect(() => {
    if (!hasUnsaved && deferredBreakpointSave.current && breakpointReady.current) {
      deferredBreakpointSave.current = false;
      persistBreakpoints(pointsRef.current, breakpointEpoch.current);
      pendingBreakpointSync.current = true; flushBreakpointSync();
    }
  }, [hasUnsaved, breakpoints, persistBreakpoints]);
  useEffect(() => {
    const epoch = ++breakpointEpoch.current;
    breakpointReady.current = !enabled; pendingToggles.current = [];
    deferredBreakpointSave.current = false;
    editHistory.current.clear();
    diskCheckpoints.current.reset({});
    setBreakpointsLoading(enabled);
    pointsRef.current = {}; setBreakpoints({});
    setConditionEditor(undefined);
    if (enabled) void request('breakpoint-configuration').then(body => {
      if (breakpointEpoch.current !== epoch) return;
      let points = body.breakpoints || {};
      diskCheckpoints.current.reset(points);
      for (const { file, line } of pendingToggles.current) points = togglePoint(points, file, line);
      const edited = pendingToggles.current.length > 0;
      pendingToggles.current = []; breakpointReady.current = true;
      setBreakpointsLoading(false);
      pointsRef.current = points; setBreakpoints(points);
      if (edited) persistBreakpoints(points, epoch);
    }).catch((reason: any) => {
      if (breakpointEpoch.current !== epoch) return;
      breakpointReady.current = true; pendingToggles.current = [];
      setBreakpointsLoading(false);
      setError(`断点未恢复：${reason.message}`); setVisible(true);
    });
    return () => { breakpointEpoch.current++; };
  }, [enabled, request, persistBreakpoints]);
  const loadTargets = useCallback(async (restore = false) => {
    targetDiscoveryStarted.current = true;
    const version = ++targetLoadVersion.current;
    setLoading(true); setError("");
    try {
      // Failure to decrypt a saved configuration must not prevent normal Run.
      const [body, saved] = await Promise.all([request("targets"), restore ? request("configurations").catch((reason: Error) => ({ configurations: [], selectedId: null, error: reason.message })) : Promise.resolve(null)]);
      if (version !== targetLoadVersion.current) return;
      retryTargets.current = false;
      setTargetsLoaded(true);
      setTargets(body.targets);
      const configuration = saved?.configurations?.find((item: NamedConfiguration) => item.id === saved.selectedId);
      if (restore && saved) { setConfigurations(saved.configurations); setConfigurationId(configuration?.id || ''); setConfigurationName(configuration?.name || '默认配置'); }
      if (restore && configuration) {
        setArgs(configuration.args); setVmArgs(configuration.vmArgs); setJavaHome(configuration.javaHome || '');
        const key = targetKey(configuration);
        const valid = body.targets.some((item: Target) => targetKey(item) === key);
        setSelected(valid ? key : "");
        if (!valid) { setError("已保存的入口不再存在，请重新选择并保存运行配置。"); setVisible(true); }
        else setConfigurationNotice("已恢复本地运行配置");
      } else {
        setSelected((value) => body.targets.some((item: Target) => targetKey(item) === value) ? value : body.targets[0] ? targetKey(body.targets[0]) : "");
        if (saved?.error) { setError(saved.error); setVisible(true); }
      }
    }
    catch (reason: any) { if (version === targetLoadVersion.current) { if (isLanguageStartupError(reason)) retryTargets.current = true; else { setError(reason.message); setVisible(true); } } }
    finally { if (version === targetLoadVersion.current) setLoading(false); }
  }, [request]);
  useEffect(() => {
    const ready = (event: Event) => {
      if (enabled && active && (!targetDiscoveryStarted.current || retryTargets.current) && (event as CustomEvent).detail?.projectId === projectId) void loadTargets(true);
    };
    window.addEventListener('code-studio:language-ready', ready);
    return () => window.removeEventListener('code-studio:language-ready', ready);
  }, [enabled, active, projectId, loadTargets]);
  useEffect(() => {
    setTargets([]); setTargetsLoaded(false); setSelected(""); setArgs(""); setVmArgs(""); setJavaHome(''); setEnvironment(undefined); setConfigurationNotice("");
    setConfigurations([]); setConfigurationId(''); setConfigurationName('默认配置');
    targetDiscoveryStarted.current = false;
    return () => { targetLoadVersion.current++; };
  }, [enabled, loadTargets]);
  useEffect(() => {
    if (!enabled || !active || (targetDiscoveryStarted.current && !retryTargets.current)) return;
    // Main-class discovery performs a workspace-wide Java search. Do not race
    // it against the first document's dependency index and automatic build.
    // Explicit Refresh still starts immediately at the user's request.
    const controller = new AbortController();
    void fetch(`/api/local/projects/${projectId}/language/status`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(body => {
        if (!controller.signal.aborted && body?.providers?.some((provider: { provider: string; phase: string }) => provider.provider === 'java' && provider.phase === 'ready') && (!targetDiscoveryStarted.current || retryTargets.current)) void loadTargets(true);
      }).catch(() => {});
    return () => controller.abort();
  }, [enabled, active, projectId, loadTargets]);
  useEffect(() => {
    if (!configure || !selected) return;
    let cancelled = false;
    setEnvironmentLoading(true); setEnvironmentError(''); setEnvironment(undefined);
    const [mainClass, projectName] = JSON.parse(selected);
    void request('environment', { mainClass, projectName }).then(body => { if (!cancelled) setEnvironment(body); }).catch(reason => { if (!cancelled) setEnvironmentError(reason.message); }).finally(() => { if (!cancelled) setEnvironmentLoading(false); });
    return () => { cancelled = true; };
  }, [configure, selected, environmentRefresh, request]);
  useEffect(() => {
    if (!enabled || !active) return;
    let cancelled = false;
    let inFlight = false;
    async function poll() {
      if (inFlight || (actionPending.current && pendingActionName.current !== 'start')) return;
      inFlight = true; const epoch = requestEpoch.current;
      try { const body = await request(); if (!cancelled && epoch === requestEpoch.current && (!actionPending.current || pendingActionName.current === 'start')) setState(body); } catch {} finally { inFlight = false; }
    }
    void poll(); const timer = window.setInterval(() => void poll(), running ? 700 : 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [request, enabled, active, running]);
  useEffect(() => {
    if (!active) { previousFrame.current = ""; return; }
    const frame = inspectionFrame; const key = frame ? `${pauseKey}:${frame.id}:${frame.path}:${frame.line}:${frame.column}` : "";
    if (key && key !== previousFrame.current) { setVisible(true); if (frame?.path) locate.current(frame); }
    previousFrame.current = key;
  }, [active, pauseKey, inspectionFrame]);
  async function action(name: string, input = {}) {
    if (actionPending.current && !(name === 'stop' && pendingActionName.current === 'start')) { if (name === 'breakpoints') pendingBreakpointSync.current = true; return; }
    actionPending.current = true; pendingActionName.current = name; const epoch = ++requestEpoch.current;
    setBusy(true); setError("");
    try { const body = await request(name, input); if (epoch === requestEpoch.current && body.status) { stateRef.current = body; setState(body); } }
    catch (reason: any) { if (epoch !== requestEpoch.current) return; if (!isLanguageStartupError(reason)) { setError(reason.message); setVisible(true); } try { const body = await request(); if (epoch === requestEpoch.current) { stateRef.current = body; setState(body); } } catch {} }
    finally { if (epoch === requestEpoch.current) { actionPending.current = false; pendingActionName.current = ''; setBusy(false); flushBreakpointSync(); } }
  }
  function flushBreakpointSync() {
    if (!pendingBreakpointSync.current || actionPending.current || unsavedRef.current) return;
    pendingBreakpointSync.current = false;
    if (stateRef.current.mode === 'debug' && ['running', 'paused'].includes(stateRef.current.status)) void action('breakpoints', { breakpoints: pointsRef.current });
  }
  async function start(mode: "run" | "debug") {
    if (hasUnsaved) { setError("请先保存修改，再运行项目。"); setVisible(true); return; }
    const target = targets.find((item) => targetKey(item) === selected); if (!target) return;
    setVisible(true);
    await action("start", { mode, mainClass: target.mainClass, projectName: target.projectName, breakpoints: pointsRef.current, args, vmArgs, javaHome });
  }
  async function saveConfiguration() {
    const target = targets.find((item) => targetKey(item) === selected);
    if (!target || actionPending.current) return;
    actionPending.current = true; setBusy(true); setError(""); setConfigurationNotice("");
    try { const body = await request("configurations", { operation: 'save', ...(configurationId ? { id: configurationId } : {}), name: configurationName, mainClass: target.mainClass, projectName: target.projectName, args, vmArgs, javaHome }); adoptConfiguration(body); setConfigurationNotice("运行配置已保存到本机"); }
    catch (reason: any) { setError(reason.message); }
    finally { actionPending.current = false; setBusy(false); flushBreakpointSync(); }
  }
  async function clearConfiguration() {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true); setError("");
    try {
      if (configurationId) { adoptConfiguration(await request('configurations', { operation: 'remove', id: configurationId })); setConfigurationNotice('已清除保存的运行配置'); }
      else { setArgs(''); setVmArgs(''); setJavaHome(''); setConfigurationName('默认配置'); setConfigurationNotice('临时参数已清空'); }
    } catch (reason: any) { setError(reason.message); }
    finally { actionPending.current = false; setBusy(false); flushBreakpointSync(); }
  }
  function adoptConfiguration(body: { configurations: NamedConfiguration[]; selectedId: string | null }) {
    const configuration = body.configurations.find(item => item.id === body.selectedId);
    setConfigurations(body.configurations); setConfigurationId(configuration?.id || ''); setConfigurationName(configuration?.name || '默认配置');
    setArgs(configuration?.args || ''); setVmArgs(configuration?.vmArgs || ''); setJavaHome(configuration?.javaHome || '');
    if (configuration) {
      const key = targetKey(configuration);
      if (targets.some(item => targetKey(item) === key)) setSelected(key);
      else { setSelected(''); setError('已保存的入口不再存在，请重新选择并保存运行配置。'); }
    }
  }
  async function selectConfiguration(id: string) {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true); setError('');
    try { adoptConfiguration(await request('configurations', { operation: 'select', id })); setConfigurationNotice('已恢复本地运行配置'); }
    catch (reason: any) { setError(reason.message); }
    finally { actionPending.current = false; setBusy(false); flushBreakpointSync(); }
  }
  const toggleBreakpoint = useRef<(file: string, line: number) => void>(() => {});
  const captureBreakpointCheckpoint = useRef<(file: string) => () => void>(() => () => {});
  captureBreakpointCheckpoint.current = file => {
    const epoch = breakpointEpoch.current;
    const commit = diskCheckpoints.current.capture(file, pointsRef.current[file] || []);
    return () => { if (epoch === breakpointEpoch.current) commit(); };
  };
  const discardBreakpointEdits = useRef<(file: string) => void>(() => {});
  discardBreakpointEdits.current = file => {
    const next = diskCheckpoints.current.discard(file, pointsRef.current);
    editHistory.current.clear(file);
    pointsRef.current = next; setBreakpoints(next); setConditionEditor(undefined);
    deferredBreakpointSave.current = true;
  };
  const migrateBreakpoint = useRef<(file: string, changes: SourceEdit[], before: number, after: number, undoRedo: boolean, flush?: boolean) => void>(() => {});
  migrateBreakpoint.current = (file, changes, before, after, undoRedo, flush) => {
    if (flush) { editHistory.current.clear(file); return; }
    if (!breakpointReady.current) return;
    const points = editHistory.current.apply(file, before, after, pointsRef.current[file] || [], changes, undoRedo);
    if (JSON.stringify(points) === JSON.stringify(pointsRef.current[file] || [])) return;
    const next = { ...pointsRef.current };
    if (points.length) next[file] = points; else delete next[file];
    // onChange runs before React publishes the new dirty-file state.
    unsavedRef.current = true; deferredBreakpointSave.current = true;
    pointsRef.current = next; setBreakpoints(next);
    setConditionEditor(undefined);
  };
  const editBreakpoint = useRef<(file: string, line: number) => void>(() => {});
  editBreakpoint.current = (file, line) => {
    if (pathOperation.current) return;
    const point = pointsRef.current[file]?.find(point => breakpointLine(point) === line);
    setConditionEditor({ file, line, value: point ? breakpointCondition(point) : '', hit: point ? breakpointHitCondition(point) : '', log: point ? breakpointLogMessage(point) : '' });
    setVisible(true);
  };
  function applyCondition() {
    if (!conditionEditor || breakpointsLoading || pathOperation.current) return;
    const { file, line, value, hit, log } = conditionEditor;
    editHistory.current.clear(file);
    const condition = value.trim();
    const hitCondition = hit.trim(); const logMessage = log.trim() ? log : '';
    if (hitCondition && (!/^[1-9]\d{0,9}$/.test(hitCondition) || Number(hitCondition) > 2147483647)) { setError('命中次数应为 1～2147483647 的整数'); return; }
    const points = (pointsRef.current[file] || []).filter(point => breakpointLine(point) !== line);
    points.push(condition || hitCondition || logMessage ? { line, ...(condition ? { condition } : {}), ...(hitCondition ? { hitCondition } : {}), ...(logMessage ? { logMessage } : {}) } : line);
    const next = { ...pointsRef.current, [file]: points.sort((a, b) => breakpointLine(a) - breakpointLine(b)) };
    pointsRef.current = next; setBreakpoints(next); setConditionEditor(undefined);
    persistBreakpoints(next, breakpointEpoch.current);
    pendingBreakpointSync.current = true; flushBreakpointSync();
  }
  toggleBreakpoint.current = (file, line) => {
    if (pathOperation.current) return;
    editHistory.current.clear(file);
    const next = togglePoint(pointsRef.current, file, line);
    pointsRef.current = next; setBreakpoints(next);
    if (breakpointReady.current) persistBreakpoints(next, breakpointEpoch.current);
    else pendingToggles.current.push({ file, line });
    pendingBreakpointSync.current = true;
    flushBreakpointSync();
  };
  const replaceBreakpointPaths = useRef<(points: Breakpoints) => void>(() => {});
  replaceBreakpointPaths.current = points => {
    editHistory.current.clear();
    diskCheckpoints.current.reset(points);
    pointsRef.current = points; setBreakpoints(points); setConditionEditor(undefined);
    // The file-operation endpoint already committed this snapshot with rename.
    deferredBreakpointSave.current = false;
  };
  async function moveWorkspaceEntry(from: string, to: string) {
    if (!breakpointReady.current || pathOperation.current || unsavedRef.current) throw new Error('请等待断点恢复完成，并先保存所有修改');
    pathOperation.current = true;
    try {
      await breakpointWrites.current;
      if (unsavedRef.current) throw new Error('移动期间出现未保存的修改，请先保存后重试');
      const response = await fetch(`/api/local/projects/${projectId}/files`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, breakpoints: pointsRef.current }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || '移动文件失败');
      replaceBreakpointPaths.current(body.breakpoints);
      return body;
    } finally { pathOperation.current = false; }
  }
  const selectedTarget = targets.find(item => targetKey(item) === selected);
  const targetOptions = targets.map(item => ({ value: targetKey(item), label: `${item.mainClass.split('.').pop()}${item.projectName ? ` · ${item.projectName}` : ''}`, description: item.mainClass }));
  const chooseTarget = (value: string) => { setSelected(value); setConfigurationNotice(''); };
  const toolbar = enabled ? <><div className="flex min-w-0 items-center gap-1">
    <Select ariaLabel="Java 启动入口" size="sm" className="w-64 min-w-0 shrink" menuMinWidth={560} title={selectedTarget ? `${selectedTarget.mainClass}${selectedTarget.projectName ? ` · ${selectedTarget.projectName}` : ''}` : undefined} value={selected} disabled={busy || loading || running} placeholder={loading ? "加载运行配置…" : !targetsLoaded ? "正在准备运行配置…" : targets.length ? "请选择 Java main 入口" : "无 Java main 入口"} options={targetOptions} onChange={chooseTarget} />
    <button className="icon-btn text-emerald-600" title="运行" disabled={busy || loading || running || !selected} onClick={() => void start("run")}><Play size={15} /></button>
    <button className="icon-btn text-indigo-500" title="Debug" disabled={busy || loading || breakpointsLoading || running || !selected} onClick={() => void start("debug")}><Bug size={15} /></button>
    {running && <button className="icon-btn text-red-500" title="停止" disabled={busy && state.status !== 'starting'} onClick={() => void action("stop")}><Square size={14} /></button>}
    <button className="icon-btn" title="刷新运行配置" disabled={busy || loading || running} onClick={() => void loadTargets()}><RefreshCw size={13} /></button>
    <button className="icon-btn" title="运行参数" aria-label="启动配置" disabled={busy || loading || running} onClick={() => setConfigure(true)}><Settings2 size={13} /></button>
    <button className="icon-btn" title="运行 / 调试控制台" onClick={() => setVisible((value) => !value)}><span className="text-[10px]">{paused ? "暂停" : "控制台"}</span></button>
  </div>{configure && active && <JavaRunConfigurationDialog onClose={() => setConfigure(false)}>
    <div className="space-y-4">
      <div className="flex items-end gap-3"><label className="min-w-0 flex-1"><span className="mb-1 block">已保存配置</span><Select ariaLabel="已保存运行配置" className="w-full" value={configurationId} placeholder="未保存配置" disabled={busy || loading || running} options={configurations.map(item => ({ value: item.id, label: item.name }))} onChange={id => void selectConfiguration(id)} /></label><button className="btn btn-ghost btn-sm" disabled={busy || loading || running} onClick={() => { setConfigurationId(''); setConfigurationName(''); setArgs(''); setVmArgs(''); setJavaHome(''); setConfigurationNotice('新配置尚未保存'); }}>新建配置</button></div>
      <label className="block">名称<input aria-label="运行配置名称" className="input mt-1 w-full text-xs" value={configurationName} maxLength={80} disabled={busy || loading || running} onChange={event => { setConfigurationName(event.target.value); setConfigurationNotice(''); }} /></label>
      <div><span className="mb-1 block">启动入口</span><Select ariaLabel="运行配置启动入口" className="w-full" menuMinWidth={560} value={selected} disabled={busy || loading || running} placeholder="请选择 Java main 入口" options={targetOptions} onChange={chooseTarget} />{selectedTarget && <p className="mt-2 break-all font-mono text-[11px] text-muted" data-java-main-class>{selectedTarget.mainClass}</p>}</div>
      <section className="rounded-xl border border-slate-200 p-3 dark:border-slate-700" data-java-environment>
        <div className="mb-2 flex items-center justify-between"><span className="font-medium">Java 编译与运行环境</span><button className="btn btn-ghost btn-sm" disabled={environmentLoading || running} onClick={() => setEnvironmentRefresh(value => value + 1)}>刷新 JDK</button></div>
        {environmentLoading && <p role="status" className="text-muted">正在读取项目配置与本机 JDK…</p>}
        {environmentError && <p role="alert" className="text-red-500">{environmentError}</p>}
        {environment && <><p className="mb-3 text-muted">项目配置：source {environment.source} / target {environment.target}{environment.release ? ' · release' : ''} · {environment.buildTool === 'maven' ? 'Maven 项目编译' : 'Eclipse 项目编译'}</p><Select ariaLabel="项目运行 JDK" className="w-full" menuMinWidth={560} value={javaHome} disabled={busy || loading || running} options={[{ value: '', label: `自动匹配项目 · Java ${environment.selected.version}`, description: environment.selected.home }, ...environment.jdks.map(jdk => ({ value: jdk.home, label: `Java ${jdk.version} · ${jdk.vendor}${jdk.arch ? ` · ${jdk.arch}` : ''}`, description: jdk.home, disabled: jdk.major < environment.required }))]} onChange={value => { setJavaHome(value); setConfigurationNotice(''); }} /><p className="mt-2 break-all text-muted">{javaHome || environment.selected.home}</p>{javaHome && !environment.jdks.some(jdk => jdk.home === javaHome && jdk.major >= environment.required) && <p role="alert" className="mt-2 text-red-500">保存的 JDK 已不可用或不兼容，请重新选择。</p>}</>}
        <p className="mt-2 text-muted">编译版本以项目配置为准，不改写 source、target 或 release。本机 JDK 用于构建进程和程序启动；项目显式配置的 toolchain 仍由构建工具决定。</p>
      </section>
      <label className="block">程序参数<input aria-label="程序参数" className="input mt-1 w-full text-xs" placeholder="--spring.profiles.active=dev" value={args} disabled={busy || loading || running} maxLength={8000} onChange={event => { setArgs(event.target.value); setConfigurationNotice(''); }} /></label>
      <label className="block">JVM 参数<input aria-label="JVM 参数" className="input mt-1 w-full text-xs" placeholder="-Xmx1g -Dkey=value" value={vmArgs} disabled={busy || loading || running} maxLength={8000} onChange={event => { setVmArgs(event.target.value); setConfigurationNotice(''); }} /></label>
      {error && <p role="alert" className="break-words text-red-500">{error}</p>}
      {configurationNotice && <p role="status" className="text-muted">{configurationNotice}</p>}
      <footer className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 dark:border-slate-700"><button className="btn btn-primary btn-sm" disabled={busy || loading || running || !selected} onClick={() => void saveConfiguration()}>保存运行配置</button><button className="btn btn-ghost btn-sm" disabled={busy || loading || running} onClick={() => void clearConfiguration()}>清除保存配置</button><button className="btn btn-secondary btn-sm ml-auto" onClick={() => setConfigure(false)}>关闭</button></footer>
    </div>
  </JavaRunConfigurationDialog>}</> : null;
  const panel = visible && enabled ? <div data-java-run-panel className="flex h-full min-h-0 flex-col border-t border-slate-200 bg-slate-50 text-xs dark:border-slate-700 dark:bg-slate-950">
    <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-1 dark:border-slate-800">
      <span>{state.mode === "debug" ? "Debug" : "运行"} · {({ idle: "就绪", starting: "启动中", running: "运行中", paused: "已暂停", stopped: "已结束", failed: "失败" } as Record<string, string>)[state.status]}</span>
      {state.mode === "debug" && running && <>
        <button className="icon-btn" title={paused ? "继续" : "暂停"} disabled={busy} onClick={() => void action(paused ? "continue" : "pause")}>{paused ? <Play size={14} /> : <Pause size={14} />}</button>
        <button className="icon-btn" title="单步跳过" disabled={!paused || busy} onClick={() => void action("next")}><StepForward size={14} /></button>
        <button className="icon-btn" title="单步进入" disabled={!paused || busy} onClick={() => void action("stepIn")}><ArrowDownToLine size={14} /></button>
        <button className="icon-btn" title="单步跳出" disabled={!paused || busy} onClick={() => void action("stepOut")}><ArrowUpFromLine size={14} /></button>
      </>}
      {running && <button className="icon-btn text-red-500" title="停止" disabled={busy && state.status !== 'starting'} onClick={() => void action("stop")}><Square size={13} /></button>}
      <button className="icon-btn ml-auto" title="关闭面板" onClick={() => setVisible(false)}><X size={13} /></button>
    </div>
    {error && <p className="shrink-0 px-3 py-1 text-red-500">{error}</p>}
    {paused && !state.framesLoading && !state.framesError && !state.frames.length && <p role="status" className="shrink-0 px-3 py-1 text-muted">所选线程没有可查看的调用栈，可能未暂停或正在执行本地方法。</p>}
    {paused && <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 p-2 dark:border-slate-800">
      <span>线程</span><Select ariaLabel="调试线程" className="min-w-0 flex-1" size="sm" value={String(state.threadId || '')} options={(state.threads || []).map(thread => ({ value: String(thread.id), label: `${thread.name} · ${thread.id}` }))} disabled={busy || !!state.framesLoading} placeholder="加载线程…" onChange={id => void action('selectThread', { threadId: Number(id), sessionId: state.sessionId, stopVersion: state.stopVersion })} />
      <button className="btn btn-ghost btn-sm" disabled={busy || !!state.framesLoading} onClick={() => void action('threads', { sessionId: state.sessionId, stopVersion: state.stopVersion })}>刷新线程</button>
      <button className="btn btn-ghost btn-sm" disabled={busy || !!state.framesLoading || !state.threadId || state.pausedThreadIds?.includes(state.threadId)} onClick={() => void action('pause', { threadId: state.threadId, sessionId: state.sessionId, stopVersion: state.stopVersion })}>暂停所选线程</button>
      <button className="btn btn-ghost btn-sm" disabled={busy || !!state.framesLoading} onClick={() => void action('continueAll')}>继续所有线程</button>
      {state.threadsTruncated && <span className="text-amber-600">仅显示前 1000 个线程及当前线程</span>}
    </div>}
    {conditionEditor && <form aria-label="断点条件设置" className="shrink-0 border-b border-slate-200 p-2 dark:border-slate-800" onSubmit={event => { event.preventDefault(); applyCondition(); }}>
      <p className="mb-1 truncate" title={conditionEditor.file}>{conditionEditor.file}:{conditionEditor.line}</p>
      <div className="flex items-center gap-2"><input aria-label="断点条件" autoFocus maxLength={2000} className="input min-w-0 flex-1 text-xs" placeholder="例如 i == 3；留空为普通断点" value={conditionEditor.value} onChange={event => setConditionEditor({ ...conditionEditor, value: event.target.value })} /><button className="btn btn-primary btn-sm" disabled={breakpointsLoading}>应用</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setConditionEditor(undefined)}>取消</button></div>
      <div className="mt-1 flex gap-2"><input aria-label="断点命中次数" inputMode="numeric" maxLength={10} className="input w-48 text-xs" placeholder="第 N 次命中（正整数）" value={conditionEditor.hit} onChange={event => setConditionEditor({ ...conditionEditor, hit: event.target.value })} /><input aria-label="断点日志消息" maxLength={2000} className="input min-w-0 flex-1 text-xs" placeholder="日志断点：例如 i = {i}；输出日志，不暂停" value={conditionEditor.log} onChange={event => setConditionEditor({ ...conditionEditor, log: event.target.value })} /></div>
      <p className="mt-1 text-[10px] text-amber-600">条件与日志表达式由调试器求值；方法调用可能产生副作用。全部留空为普通断点。</p>
    </form>}
    {state.breakpoints?.filter((point) => !point.verified).map((point) => <p key={`${point.path}:${point.line}`} className="px-3 text-amber-600">断点 {point.path}:{point.line} · {point.message || "尚未绑定"}</p>)}
    <div className="flex min-h-0 flex-1">
      {state.issues?.length ? <div className="w-1/2 overflow-auto border-r border-slate-200 p-2 dark:border-slate-800"><p className="mb-1 text-slate-400">编译问题（{state.issues.length}）</p>{state.issues.map((issue, index) => <button key={index} className="block w-full rounded p-1 text-left text-red-500 hover:bg-slate-200 dark:hover:bg-slate-800" title={issue.message} onClick={() => locate.current({ id: 0, name: issue.message, path: issue.path, line: issue.line, column: issue.column })}><span className="block font-mono text-[10px]">{issue.path}:{issue.line}</span>{issue.message}</button>)}</div> : null}
      {paused && <div className="w-1/3 overflow-auto border-r border-slate-200 p-2 dark:border-slate-800"><p className="mb-1 text-slate-400">调用栈</p>{state.framesLoading && <p>加载调用栈…</p>}{state.framesError && <p className="text-red-500">{state.framesError}</p>}{state.frames.map((frame) => <button key={frame.id} className={`block w-full truncate rounded p-1 text-left hover:bg-slate-200 dark:hover:bg-slate-800 ${inspectionFrame?.id === frame.id ? "bg-indigo-100 text-indigo-600 dark:bg-indigo-950" : ""}`} onClick={() => setInspectionSelection({ pauseKey, id: frame.id })}>{frame.name}:{frame.line}</button>)}</div>}
      {paused && <DebugVariables key={`${pauseKey}:${inspectionFrame?.id}`} frame={inspectionFrame} request={inspectRequest} />}
      <pre className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px]">{state.logs.join("") || "点击编辑器行号左侧可设置断点。"}</pre>
    </div>
  </div> : null;
  return { toolbar, panel, breakpoints, toggleBreakpoint, editBreakpoint, migrateBreakpoint, moveWorkspaceEntry, captureBreakpointCheckpoint, discardBreakpointEdits, pausedFrame: inspectionFrame };
}
function targetKey(target: Pick<Target, 'mainClass' | 'projectName'>) { return JSON.stringify([target.mainClass, target.projectName]); }
function DebugVariables({ frame, request }: { frame?: Frame; request: (action: string, input: any) => Promise<any> }) {
  const [scopes, setScopes] = useState<{ name: string; variablesReference: number }[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);
  useEffect(() => { let cancelled = false; setScopes([]); setError(""); setLoading(Boolean(frame)); if (frame) void request("scopes", { frameId: frame.id }).then((body) => { if (!cancelled) setScopes(body.scopes || []); }).catch((error) => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [frame?.id, request, refreshVersion]);
  return <div className="w-1/3 overflow-auto border-r border-slate-200 p-2 dark:border-slate-800"><p className="mb-1 text-slate-400">变量</p>{loading && <p>加载变量…</p>}{!frame && <p className="text-slate-400">等待调用栈…</p>}{error && <p className="text-red-500">{error}</p>}{!loading && frame && !error && !scopes.length && <p className="text-slate-400">该调用帧没有可读取的变量。</p>}{scopes.map((scope) => <VariableGroup key={`${refreshVersion}:${scope.variablesReference}`} name={scope.name} reference={scope.variablesReference} request={request} initialOpen />)}{frame && <DebugEvaluation frame={frame} request={request} onEvaluated={refresh} />}</div>;
}
function DebugEvaluation({ frame, request, onEvaluated }: { frame: Frame; request: (action: string, input: any) => Promise<any>; onEvaluated: () => void }) {
  const [expression, setExpression] = useState("");
  const [result, setResult] = useState<{ expression: string; result: string; type?: string; variablesReference: number }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => { generation.current++; setResult(undefined); setError(""); setBusy(false); inFlight.current = false; return () => { generation.current++; }; }, [frame.id, request]);
  async function evaluate() {
    if (inFlight.current || !expression.trim()) return;
    inFlight.current = true; setBusy(true); setError(""); setResult(undefined);
    const version = generation.current;
    try {
      const body = await request("evaluate", { frameId: frame.id, expression });
      if (version !== generation.current) return;
      setResult({ ...body, expression }); onEvaluated();
    } catch (reason: any) { if (version === generation.current) { setError(reason.message); onEvaluated(); } }
    finally { if (version === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  return <div className="mt-3 border-t border-slate-200 pt-2 dark:border-slate-800"><p className="mb-1 text-slate-400">表达式求值</p><form className="flex gap-1" onSubmit={(event) => { event.preventDefault(); void evaluate(); }}><input className="input min-w-0 flex-1 text-xs" aria-label="调试表达式" placeholder="例如 answer + 1" maxLength={4000} value={expression} disabled={busy} onChange={(event) => { setExpression(event.target.value); setResult(undefined); setError(""); }} /><button className="btn shrink-0 text-xs" type="submit" disabled={busy || !expression.trim()}>{busy ? "求值中…" : "求值"}</button></form><p className="mt-1 text-[10px] text-amber-600">在当前调用帧执行；方法调用或赋值可能改变程序状态。</p>{error && <p role="alert" className="mt-1 break-words text-red-500">{error}</p>}{result && <div data-debug-evaluation-result className="mt-1 break-words" title={result.type}>{result.variablesReference > 0 ? <VariableGroup key={`${result.expression}:${result.variablesReference}`} name={`${result.expression}: ${result.result}`} reference={result.variablesReference} request={request} /> : <p>{result.expression}: {result.result}</p>}</div>}</div>;
}
function VariableGroup({ name, reference, request, initialOpen = false }: { name: string; reference: number; request: (action: string, input: any) => Promise<any>; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [variables, setVariables] = useState<Variable[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { let cancelled = false; if (open) { setLoading(true); setError(""); void request("variables", { variablesReference: reference }).then((body) => { if (!cancelled) setVariables(body.variables || []); }).catch((error) => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setLoading(false); }); } return () => { cancelled = true; }; }, [open, reference, request]);
  return <div><button className="max-w-full truncate text-left" title={name} onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {name}</button>{open && <div className="pl-3">{loading && <p className="text-slate-400">加载中…</p>}{error && <p className="text-red-500">{error}</p>}{!loading && !error && !variables.length && <p className="text-slate-400">无可用变量</p>}{variables.map((variable, index) => variable.variablesReference > 0 ? <VariableGroup key={index} name={`${variable.name}: ${variable.value}`} reference={variable.variablesReference} request={request} /> : <p key={index} className="truncate" title={`${variable.type || ""} ${variable.value}`}>{variable.name}: {variable.value}</p>)}</div>}</div>;
}
