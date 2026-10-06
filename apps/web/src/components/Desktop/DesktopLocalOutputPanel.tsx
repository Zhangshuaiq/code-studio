import { useCallback, useEffect, useState } from "react";
import { Bot, LoaderCircle, Play, SquareTerminal, X } from "lucide-react";
import { DesktopTerminal } from "./DesktopTerminal";

interface Activity {
  preview: { status: string; targetLabel?: string | null; port?: number | null; logs: string[] };
  terminal: { status: string; shell: string; exitCode?: number | null } | null;
  agentTasks: Array<{ id: string; status: string; summary: string; createdAt: string; error?: string | null }>;
}

export function DesktopLocalOutputPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [tab, setTab] = useState<"terminal" | "run">("terminal");
  const [activity, setActivity] = useState<Activity>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/local/projects/${projectId}/activity`); const body = await response.json();
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      setActivity(body); setError("");
    } catch (reason: any) { setError(String(reason?.message || reason)); }
  }, [projectId]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 1_500); return () => window.clearInterval(timer); }, [load]);
  return <div className="flex h-full min-h-0 flex-col bg-slate-950 text-slate-200">
    <div className="flex h-8 shrink-0 items-center border-b border-slate-800 px-2 text-[10px]">
      <OutputTab active={tab === "terminal"} onClick={() => setTab("terminal")}><SquareTerminal size={12} />终端{activity?.terminal?.status === "running" ? " · 运行中" : ""}</OutputTab>
      <OutputTab active={tab === "run"} onClick={() => setTab("run")}><Play size={12} />运行输出{["building", "starting", "running"].includes(activity?.preview?.status || "") ? " · 运行中" : ""}</OutputTab>
      <button type="button" className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-800" onClick={onClose} title="隐藏面板"><X size={12} /></button>
    </div>
    <div className="min-h-0 flex-1">{tab === "terminal" ? <DesktopTerminal projectId={projectId} onClose={onClose} embedded /> : <RunOutput activity={activity} error={error} />}</div>
  </div>;
}

function OutputTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`flex h-full items-center gap-1.5 border-b-2 px-3 ${active ? "border-indigo-400 text-white" : "border-transparent text-slate-400 hover:text-slate-200"}`}>{children}</button>;
}

function RunOutput({ activity, error }: { activity?: Activity; error: string }) {
  if (error) return <div className="p-3 text-xs text-red-400">{error}</div>;
  if (!activity) return <div className="grid h-full place-items-center text-slate-500"><LoaderCircle size={15} className="animate-spin" /></div>;
  const preview = activity.preview; const tasks = activity.agentTasks;
  return <div className="h-full overflow-auto p-3 font-mono text-[11px] leading-5">
    <div className="mb-2 flex items-center gap-2 text-slate-400"><Play size={12} /><span>{preview.targetLabel || "项目运行"}</span><Status value={preview.status} />{preview.port ? <span>127.0.0.1:{preview.port}</span> : null}</div>
    <pre className="whitespace-pre-wrap text-slate-300">{preview.logs?.length ? preview.logs.join("\n") : "暂无运行输出"}</pre>
    {tasks.length > 0 && <div className="mt-4 border-t border-slate-800 pt-3"><div className="mb-2 flex items-center gap-2 text-slate-400"><Bot size={12} />最近任务</div>{tasks.map((task) => <div key={task.id} className="flex gap-2 py-0.5"><Status value={task.status} /><span className="min-w-0 truncate text-slate-300">{task.summary}</span>{task.error && <span className="text-red-400">{task.error}</span>}</div>)}</div>}
  </div>;
}

const STATUS_LABEL: Record<string, string> = { queued: "等待中", building: "构建中", running: "运行中", starting: "启动中", succeeded: "已完成", stopped: "已停止", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
function Status({ value }: { value: string }) { const active = ["building", "running", "starting", "queued"].includes(value); const failed = value === "failed"; return <span className={failed ? "text-red-400" : active ? "text-emerald-400" : "text-slate-500"}>[{STATUS_LABEL[value] || value}]</span>; }
