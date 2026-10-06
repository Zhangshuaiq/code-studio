import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { LoaderCircle, Play, Trash2, X } from "lucide-react";

interface TerminalSession { id: string; status: string; shell: string; exitCode: number | null; sequence: number; chunks?: Array<{ sequence: number; data: string }> }

export function DesktopTerminal({ projectId, onClose, embedded = false }: { projectId: string; onClose: () => void; embedded?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null); const terminalRef = useRef<Terminal>(); const fitRef = useRef<FitAddon>();
  const sequenceRef = useRef(0); const sessionIdRef = useRef<string>(); const [session, setSession] = useState<TerminalSession>(); const [starting, setStarting] = useState(false); const [error, setError] = useState("");
  const attach = useCallback((next: TerminalSession) => { sessionIdRef.current = next.id; setSession(next); sequenceRef.current = next.sequence || 0; }, []);
  useEffect(() => {
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", theme: { background: "#020617", foreground: "#e2e8f0", cursor: "#818cf8", selectionBackground: "#334155" }, scrollback: 5_000 });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(hostRef.current!); terminalRef.current = terminal; fitRef.current = fit;
    const resize = () => { try { fit.fit(); if (sessionIdRef.current) void fetch(`/api/local/terminal/${sessionIdRef.current}/resize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }) }); } catch {} };
    const observer = new ResizeObserver(resize); observer.observe(hostRef.current!); window.setTimeout(resize, 0);
    const input = terminal.onData((data) => { if (sessionIdRef.current) void fetch(`/api/local/terminal/${sessionIdRef.current}/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }); });
    return () => { input.dispose(); observer.disconnect(); terminal.dispose(); terminalRef.current = undefined; };
  }, []);
  useEffect(() => { void fetch(`/api/local/projects/${projectId}/terminal?after=0`).then((response) => response.json()).then((body) => { if (body.id) { terminalRef.current?.write((body.chunks || []).map((item: any) => item.data).join("")); attach(body); } }); }, [projectId, attach]);
  useEffect(() => {
    if (!session?.id || session.status !== "running") return;
    const timer = window.setInterval(async () => {
      try { const response = await fetch(`/api/local/terminal/${session.id}?after=${sequenceRef.current}`); const body = await response.json(); if (!response.ok) return; for (const chunk of body.chunks || []) { terminalRef.current?.write(chunk.data); sequenceRef.current = chunk.sequence; } setSession((current) => current ? { ...current, status: body.status, exitCode: body.exitCode, sequence: body.sequence } : body); }
      catch {}
    }, 120); return () => window.clearInterval(timer);
  }, [session?.id, session?.status]);
  async function start() {
    if (!window.confirm("终端可以执行命令并修改项目文件，是否继续？")) return;
    setStarting(true); setError("");
    try { const fit = fitRef.current; fit?.fit(); const response = await fetch(`/api/local/projects/${projectId}/terminal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, cols: terminalRef.current?.cols, rows: terminalRef.current?.rows }) }); const body = await response.json(); if (!response.ok) throw new Error(body.message); terminalRef.current?.reset(); attach(body); terminalRef.current?.focus(); }
    catch (reason: any) { setError(String(reason?.message || reason)); } finally { setStarting(false); }
  }
  async function terminate() { if (!session?.id || !window.confirm("确定结束当前终端吗？")) return; await fetch(`/api/local/terminal/${session.id}`, { method: "DELETE" }); terminalRef.current?.writeln("\r\n\x1b[90m终端已结束\x1b[0m"); sessionIdRef.current = undefined; setSession(undefined); }
  return <div className="relative flex h-full min-h-0 flex-col bg-slate-950">{!embedded && <div className="flex h-8 shrink-0 items-center gap-2 border-b border-slate-800 px-3 text-[10px] text-slate-400"><span className="font-semibold text-slate-200">终端</span>{session && <span>{session.shell}{session.status === "exited" ? ` · 已退出 (${session.exitCode ?? "-"})` : ""}</span>}<div className="ml-auto flex items-center gap-1">{session && <button type="button" className="rounded p-1 hover:bg-slate-800 hover:text-red-400" onClick={() => void terminate()} title="结束终端"><Trash2 size={12} /></button>}<button type="button" className="rounded p-1 hover:bg-slate-800" onClick={onClose} title="隐藏终端"><X size={12} /></button></div></div>}<div ref={hostRef} className="min-h-0 flex-1 p-1" />{embedded && session && <button type="button" className="absolute right-2 top-2 z-10 rounded bg-slate-900/80 p-1 text-slate-400 hover:text-red-400" onClick={() => void terminate()} title="结束终端"><Trash2 size={12} /></button>}{!session && <div className={`absolute inset-x-0 bottom-0 grid place-items-center bg-slate-950/90 ${embedded ? "top-0" : "top-8"}`}><div className="text-center"><button type="button" className="btn btn-primary btn-sm" disabled={starting} onClick={() => void start()}>{starting ? <LoaderCircle size={13} className="animate-spin" /> : <Play size={13} />}启动终端</button>{error && <p className="mt-2 text-[10px] text-red-400">{error}</p>}</div></div>}</div>;
}
