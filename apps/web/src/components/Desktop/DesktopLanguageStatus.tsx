import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { FastIndexStatus } from '../../hooks/useSessionFiles';

type ProviderStatus = { provider: string; phase: string; message: string; elapsedMs?: number; backgroundTasks?: number };
export function semanticStatusText(current: ProviderStatus | undefined, message: string, loading: boolean) {
  if (current?.provider !== 'java' || !loading) return message;
  if (current.phase !== 'indexing') return '语义服务正在加载';
  const tasks = Number.isSafeInteger(current.backgroundTasks) && Number(current.backgroundTasks) > 0 ? ` · ${current.backgroundTasks} 项任务` : '';
  return `正在后台分析与构建${tasks}`;
}
export function isLanguageStartupError(error: { code?: string }) {
  return ['LOCAL_LSP_UNAVAILABLE', 'LOCAL_LSP_TIMEOUT', 'LSP_CAPACITY_EXCEEDED'].includes(error?.code || '');
}

type StatusTransport = (operation: 'prepare' | 'status', signal: AbortSignal) => Promise<{ providers?: ProviderStatus[] }>;
type IndexTransport = (signal: AbortSignal) => Promise<{ index: FastIndexStatus & { backgroundError?: string } }>;
export function fastIndexStatusText(index?: FastIndexStatus & { backgroundError?: string }) {
  if (!index) return '';
  const count = Math.max(0, Number(index.files) || 0);
  if (index.backgroundError) return count ? `快速索引部分可用 · ${count} 文件 · 后台更新暂未完成` : '快速索引暂未就绪';
  if (index.state === 'ready' && index.complete) return `快速索引就绪 · ${count} 文件`;
  if (index.state === 'scanning' && Number.isSafeInteger(index.discoveredFiles) && Number(index.discoveredFiles) > 0) {
    const reused = Math.max(0, Number(index.unchangedFiles) || 0);
    const parsed = Math.max(0, Number(index.parsedFiles) || 0);
    return `快速索引更新中 · 已检查 ${index.discoveredFiles} 文件 · 缓存复用 ${reused} · 新解析 ${parsed}`;
  }
  if (['starting', 'needs-scan', 'needs-validation', 'scanning'].includes(index.state)) return count ? `缓存符号可用 · ${count} 文件 · 后台校验中` : '快速索引正在建立';
  return count ? `快速索引部分可用 · ${count} 文件` : '快速索引尚无项目符号';
}
export function DesktopLanguageStatus({ projectId, active, transport, indexTransport, includeFastIndex = false, prepareOnMount = true }: { projectId: string; active: boolean; transport?: StatusTransport; indexTransport?: IndexTransport; includeFastIndex?: boolean; prepareOnMount?: boolean }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [preparing, setPreparing] = useState(true);
  const [connectionPending, setConnectionPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fastIndex, setFastIndex] = useState<FastIndexStatus & { backgroundError?: string }>();
  const previousJavaPhase = useRef('');
  const statusReceived = useRef(false);
  const base = `/api/local/projects/${projectId}/language`;
  const transportRef = useRef(transport); transportRef.current = transport;
  const indexTransportRef = useRef(indexTransport); indexTransportRef.current = indexTransport;
  const request = async (operation: 'prepare' | 'status', signal: AbortSignal) => {
    if (transportRef.current) return transportRef.current(operation, signal);
    const response = await fetch(`${base}/${operation}`, { method: operation === 'prepare' ? 'POST' : 'GET', signal });
    if (!response.ok) throw new Error('status unavailable');
    return response.json();
  };
  useEffect(() => {
    statusReceived.current = false;
    previousJavaPhase.current = '';
    setProviders([]);
    setConnectionPending(false);
    setFastIndex(undefined);
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    if (!active) return () => controller.abort();
    if (!prepareOnMount && attempt === 0) { setPreparing(false); return () => controller.abort(); }
    setPreparing(true);
    void request('prepare', controller.signal)
      .catch(() => { if (!controller.signal.aborted && !statusReceived.current) setConnectionPending(true); })
      .finally(() => { if (!controller.signal.aborted) setPreparing(false); });
    return () => controller.abort();
  }, [base, attempt, prepareOnMount, active]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failedPolls = 0;
    async function poll() {
      try {
        const body = await request('status', controller.signal);
        if (controller.signal.aborted) return;
        statusReceived.current = true;
        failedPolls = 0;
        setProviders(body.providers || []); setConnectionPending(false);
        const javaPhase = body.providers?.find((item: ProviderStatus) => item.provider === 'java')?.phase;
        if (javaPhase === 'ready' && previousJavaPhase.current !== 'ready') window.dispatchEvent(new CustomEvent('code-studio:language-ready', { detail: { projectId } }));
        previousJavaPhase.current = javaPhase || '';
      } catch {
        failedPolls++;
        if (!controller.signal.aborted && (!statusReceived.current || failedPolls >= 3)) setConnectionPending(true);
      }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base, active, projectId]);
  const hasJava = providers.some(provider => provider.provider === 'java');
  useEffect(() => {
    if (!active || (!hasJava && !includeFastIndex)) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function pollIndex() {
      try {
        const body = indexTransportRef.current ? await indexTransportRef.current(controller.signal) : await fetch(`${base}/index-status`, { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error('index status unavailable'); return response.json(); });
        if (!controller.signal.aborted) setFastIndex(body.index);
      } catch { if (!controller.signal.aborted) setFastIndex(undefined); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void pollIndex(), 2000); }
    }
    void pollIndex(); return () => { controller.abort(); clearTimeout(timer); };
  }, [base, active, hasJava, includeFastIndex, projectId]);
  const busy = providers.filter((item) => ['initializing', 'importing', 'indexing'].includes(item.phase));
  const failed = providers.filter((item) => item.phase === 'failed');
  const loading = busy.length > 0 || (preparing && !providers.length);
  const current = busy[0] || failed[0];
  const elapsed = Math.floor(Math.max(0, ...busy.map((item) => item.elapsedMs || 0)) / 1000);
  const message = loading ? current?.message || '正在加载代码智能' : failed.length ? '代码智能暂未就绪，可继续编辑' : connectionPending ? (statusReceived.current ? '代码智能状态更新暂不可用' : '正在连接代码智能') : providers.some((item) => item.phase === 'ready') ? '代码智能已就绪' : '';
  const fastText = fastIndexStatusText(fastIndex);
  const semanticMessage = semanticStatusText(current, message, loading);
  if (!message && !fastText) return null;
  return <div className="flex h-7 shrink-0 items-center gap-2 border-t border-slate-200 px-3 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400" data-language-status>
    {loading && <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden />}
    <span role="status" className="truncate">{fastText && <span data-fast-index-status>{fastText} · </span>}{current ? `${current.provider === 'java' ? 'Java' : current.provider} · ` : ''}{semanticMessage}{loading && elapsed > 0 ? ` · ${elapsed}s` : ''}</span>
    {loading && <div role="progressbar" aria-label="代码智能加载进度" aria-valuetext="正在后台加载" className="ml-auto h-1 w-24 shrink-0 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full w-full animate-pulse rounded-full bg-indigo-400" /></div>}
    {!loading && (failed.length > 0 || connectionPending) && <button type="button" className="ml-auto flex shrink-0 items-center gap-1 text-indigo-500 hover:text-indigo-600" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={11} />重试</button>}
  </div>;
}
