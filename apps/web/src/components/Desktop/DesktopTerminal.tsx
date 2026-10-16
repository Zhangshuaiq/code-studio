import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ITheme } from '@xterm/xterm';
import palette from '@codegen/code-intelligence/terminal-theme.cjs';
import { useEditorPreferences } from '../../store/editorPreferences';
import { useTheme } from '../../store/theme';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Plus, Trash2, X } from 'lucide-react';
interface TerminalSession { id: string; status: string; shell: string; exitCode: number | null; sequence: number }
export function DesktopTerminal({ projectId, onClose, embedded = false }: { projectId: string; onClose: () => void; embedded?: boolean }) {
  const appearance = useEditorPreferences(state => state.appearance), uiTheme = useTheme(state => state.theme);
  const theme = useMemo(() => palette.terminalTheme(appearance, uiTheme), [appearance, uiTheme]);
  const [sessions, setSessions] = useState<TerminalSession[]>([]), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), alive = useRef(true);
  async function create(newSession: boolean) {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try {
      const response = await fetch(`/api/local/projects/${projectId}/terminal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, newSession }) });
      const item = await response.json(); if (!response.ok) throw Error(item.message || '终端启动失败');
      if (alive.current) { setSessions(current => current.some(value => value.id === item.id) ? current : [...current, item]); setSelected(item.id); }
    } catch (reason: any) { if (alive.current) setError(reason.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true; let cancelled = false;
    void fetch(`/api/local/projects/${projectId}/terminals`).then(async response => { const body = await response.json(); if (!response.ok) throw Error(body.message || '读取终端失败'); if (cancelled) return; if (body.items.length) { setSessions(body.items); setSelected(body.items.at(-1).id); } else await create(false); }).catch(reason => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; alive.current = false; };
  }, [projectId]);
  async function close(id: string) {
    if (!window.confirm('确定结束这个终端及其正在执行的命令吗？')) return;
    try { const response = await fetch(`/api/local/terminal/${id}`, { method: 'DELETE' }); if (!response.ok && response.status !== 404) throw Error('结束终端失败'); const next = sessions.filter(item => item.id !== id); setSessions(next); if (selected === id) setSelected(next.at(-1)?.id || ''); } catch (reason: any) { setError(reason.message); }
  }
  return <div className="workspace-terminal flex h-full min-h-0 flex-col" style={{ backgroundColor: theme.background, color: theme.foreground, '--terminal-selection': theme.selectionBackground } as CSSProperties} data-desktop-terminals>
    <header className="flex h-8 shrink-0 items-center gap-1 overflow-auto border-b border-current/20 px-2 text-[11px]">
      {sessions.map((session,index) => <button key={session.id} data-terminal-tab={session.id} aria-selected={session.id === selected} className="shrink-0 rounded px-2 py-1" onClick={() => setSelected(session.id)}>{session.shell} {index+1}</button>)}
      <button title="新建终端" aria-label="新建终端" className="rounded p-1" disabled={busy || sessions.length >= 10} onClick={() => void create(true)}><Plus size={14}/></button>
      {selected && <button title="结束终端" className="rounded p-1 hover:text-red-400" onClick={() => void close(selected)}><Trash2 size={13}/></button>}
      {!embedded && <button title="隐藏终端" className="ml-auto rounded p-1" onClick={onClose}><X size={13}/></button>}
    </header>
    {error && <p role="alert" className="p-2 text-xs text-red-400">{error}</p>}
    {busy && !sessions.length && <p role="status" className="p-2 text-xs text-slate-400">正在打开终端…</p>}
    <div className="relative min-h-0 flex-1">{sessions.map(session => <div key={session.id} data-terminal-session={session.id} className="absolute inset-0" style={{ display: selected === session.id ? 'block' : 'none' }} aria-hidden={selected !== session.id}><TerminalView session={session} active={selected === session.id} theme={theme}/></div>)}</div>
  </div>;
}
function TerminalView({ session, active, theme }: { session: TerminalSession; active: boolean; theme: ITheme }) {
  const host = useRef<HTMLDivElement>(null), terminalRef = useRef<Terminal>(), fitRef = useRef<FitAddon>();
  const after = useRef(0), inFlight = useRef(false); const [status, setStatus] = useState(session.status);
  useEffect(() => {
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', theme, scrollback: 5000 });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!); terminalRef.current = terminal; fitRef.current = fit;
    const resize = () => { if (!host.current?.offsetParent) return; try { fit.fit(); void fetch(`/api/local/terminal/${session.id}/resize`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({cols:terminal.cols,rows:terminal.rows}) }); } catch {} };
    const observer = new ResizeObserver(resize); observer.observe(host.current!);
    const input = terminal.onData(data => { void fetch(`/api/local/terminal/${session.id}/input`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({data}) }); });
    return () => { input.dispose(); observer.disconnect(); terminal.dispose(); terminalRef.current = undefined; };
  }, [session.id]);
  useEffect(() => { if (terminalRef.current) terminalRef.current.options.theme = theme; }, [theme]);
  useEffect(() => { if (active) { try { fitRef.current?.fit(); terminalRef.current?.focus(); } catch {} } }, [active]);
  useEffect(() => {
    let cancelled = false;
    async function poll() { if (inFlight.current) return; inFlight.current = true; try { const response=await fetch(`/api/local/terminal/${session.id}?after=${after.current}`), body=await response.json(); if (cancelled || !response.ok) return; for (const chunk of body.chunks || []) { terminalRef.current?.write(chunk.data); after.current=chunk.sequence; } setStatus(body.status); } catch {} finally { inFlight.current=false; } }
    void poll(); const timer=window.setInterval(()=>void poll(),active?150:1000); return()=>{cancelled=true;window.clearInterval(timer)};
  }, [session.id, active]);
  return <div className="flex h-full min-h-0 flex-col"><div ref={host} className="min-h-0 flex-1 p-1"/>{status === 'exited' && <p className="px-2 text-[11px] text-slate-400">终端已退出；点击 ＋ 新建终端。</p>}</div>;
}
