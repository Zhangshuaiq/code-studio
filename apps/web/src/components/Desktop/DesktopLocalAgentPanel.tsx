import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, CircleDot, LoaderCircle, SendHorizontal, Square, UserRound } from "lucide-react";
import { Select } from "../common/Select";

interface LocalModel { id: string; name: string; engine: string; model: string }
interface CodexModel { id: string; name: string; defaultReasoningEffort: string; reasoningEfforts: { value: string; description: string }[] }
interface AgentEvent { sequence: number; kind: string; text?: string; toolName?: string; toolInput?: unknown }
interface AgentTask { id: string; modelConfigId: string; selectedModel?: string; reasoningEffort?: string; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; prompt: string; permissionProfile: "read-only" | "workspace-write"; status: string; error?: string; createdAt: string; events?: AgentEvent[] }
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

export function DesktopLocalAgentPanel({ projectId, onFilesChanged }: { projectId: string; onFilesChanged: () => void }) {
  const [models, setModels] = useState<LocalModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<AgentTask>();
  const [prompt, setPrompt] = useState("");
  const [permissionProfile, setPermissionProfile] = useState<"read-only" | "workspace-write">("read-only");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  async function loadInitial() {
    try {
      const [modelsResponse, tasksResponse, catalogResponse] = await Promise.all([fetch("/api/local/models"), fetch(`/api/local/projects/${projectId}/agent/tasks`), fetch("/api/local/models/catalog?engine=codex-cli")]);
      const modelsBody = await modelsResponse.json(); const tasksBody = await tasksResponse.json(); const catalogBody = await catalogResponse.json().catch(() => ({ items: [] }));
      if (!modelsResponse.ok) throw new Error(modelsBody.message || `HTTP ${modelsResponse.status}`);
      if (!tasksResponse.ok) throw new Error(tasksBody.message || `HTTP ${tasksResponse.status}`);
      setModels(modelsBody.items); setModelId((current) => current || modelsBody.items[0]?.id || "");
      setCodexModels(catalogResponse.ok ? catalogBody.items || [] : []);
      const history = await Promise.all((tasksBody.items as AgentTask[]).map(async (task) => {
        try { const response = await fetch(`/api/local/agent/tasks/${task.id}`); return response.ok ? await response.json() : task; }
        catch { return task; }
      }));
      setTasks(history);
      const runningTask = history.find((task) => !TERMINAL.has(task.status));
      if (runningTask) setSelectedTask(runningTask);
    } catch (reason: any) { setError(String(reason?.message || reason)); }
  }
  useEffect(() => { void loadInitial(); }, [projectId]);
  useEffect(() => {
    const connection = models.find((item) => item.id === modelId);
    if (connection?.engine !== "codex-cli") { setSelectedModel(""); setReasoningEffort(""); return; }
    const model = codexModels.find((item) => item.id === connection.model) || codexModels[0];
    setSelectedModel(model?.id || connection.model || ""); setReasoningEffort(model?.defaultReasoningEffort || "medium");
  }, [modelId, models, codexModels]);

  async function loadTask(id: string) {
    const response = await fetch(`/api/local/agent/tasks/${id}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    setSelectedTask((previous) => {
      if (previous && previous.id === body.id && !TERMINAL.has(previous.status) && TERMINAL.has(body.status)) onFilesChanged();
      return body;
    });
    setTasks((items) => items.map((item) => item.id === body.id ? { ...item, ...body } : item));
    return body as AgentTask;
  }

  useEffect(() => {
    if (!selectedTask || TERMINAL.has(selectedTask.status)) return;
    const timer = window.setInterval(() => void loadTask(selectedTask.id).catch((reason) => setError(String(reason?.message || reason))), 500);
    return () => window.clearInterval(timer);
  }, [selectedTask?.id, selectedTask?.status]);

  useEffect(() => {
    if (!selectedTask || TERMINAL.has(selectedTask.status)) return;
    const startedAt = new Date(selectedTask.createdAt).getTime();
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [selectedTask?.id, selectedTask?.status]);

  async function start() {
    const taskPrompt = prompt.trim();
    if (!modelId || !taskPrompt) return;
    setSubmitting(true); setError("");
    try {
      let approvalToken: string | undefined;
      if (permissionProfile === "workspace-write") {
        const approval = await window.desktopRuntime?.approveAgentWrite({ projectId, modelConfigId: modelId, prompt: taskPrompt });
        if (!approval?.ok) { if (approval?.message) setError(approval.message); return; }
        approvalToken = approval.approvalToken;
      }
      const response = await fetch(`/api/local/projects/${projectId}/agent/tasks`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelConfigId: modelId, prompt: taskPrompt, permissionProfile, approvalToken, ...(models.find((item) => item.id === modelId)?.engine === "codex-cli" ? { model: selectedModel, reasoningEffort } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      setPrompt(""); setSelectedTask(body); setTasks((items) => [{ ...body, events: undefined }, ...items]);
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setSubmitting(false); }
  }

  async function cancel() {
    if (!selectedTask) return;
    const response = await fetch(`/api/local/agent/tasks/${selectedTask.id}/cancel`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) setError(body.message || `HTTP ${response.status}`); else setSelectedTask(body);
  }

  const running = selectedTask && !TERMINAL.has(selectedTask.status);
  const conversation = useMemo(() => [...tasks].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()), [tasks]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex min-h-[58px] items-center gap-3 border-b border-slate-200 px-4 dark:border-slate-800"><span className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"><Bot size={17} /></span><div className="min-w-0"><h2 className="text-sm font-bold">项目对话</h2><div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400"><CircleDot size={9} className={running ? "text-amber-500" : "text-emerald-500"} />{running ? "正在执行任务" : modelId ? "就绪" : "请选择模型"}</div></div></header>
    <div className="min-h-0 flex-1 space-y-5 overflow-auto px-4 py-5">{conversation.length ? conversation.map((task) => {
      const pending = !TERMINAL.has(task.status);
      const text = task.events?.filter((event) => event.kind === "text" || event.kind === "reasoning" || event.kind === "tool_use").map((event) => event.kind === "tool_use" ? `· ${describeTool(event)}` : event.text || "").filter(Boolean).join("\n") || "";
      return <div key={task.id} className="space-y-5"><Message role="user">{task.prompt}</Message><Message role="assistant" pending={pending} elapsed={pending && selectedTask?.id === task.id ? elapsedSeconds : 0} usage={taskUsage(task)} model={task.selectedModel}>{text}</Message></div>;
    }) : <div className="grid h-full place-items-center text-center text-xs text-slate-400"><span><Bot size={22} className="mx-auto mb-2" />描述一个任务，开始协作</span></div>}</div>
    <div className="border-t border-slate-200 p-3 dark:border-slate-800"><div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm focus-within:border-slate-400 dark:border-slate-700 dark:bg-slate-900"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void start(); } }} rows={3} className="w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none" placeholder="向智能体描述你的任务…" /><div className="mt-1 flex flex-wrap items-center gap-2 px-1"><Select className="min-w-40 flex-1" size="sm" value={modelId} placeholder="选择平台连接" options={models.map((model) => ({ value: model.id, label: model.name }))} onChange={setModelId} disabled={Boolean(running)} />{models.find((item) => item.id === modelId)?.engine === "codex-cli" && <><Select className="min-w-40 flex-1" size="sm" value={selectedModel} placeholder="选择 Codex 模型" options={codexModels.map((model) => ({ value: model.id, label: model.name }))} onChange={(value) => { setSelectedModel(value); const model = codexModels.find((item) => item.id === value); setReasoningEffort(model?.defaultReasoningEffort || "medium"); }} disabled={Boolean(running)} /><Select className="w-28" size="sm" value={reasoningEffort} placeholder="推理强度" options={(codexModels.find((item) => item.id === selectedModel)?.reasoningEfforts || []).map((item) => ({ value: item.value, label: effortLabel(item.value) }))} onChange={setReasoningEffort} disabled={Boolean(running)} /></>}<div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">{(["read-only", "workspace-write"] as const).map((profile) => <button type="button" key={profile} onClick={() => setPermissionProfile(profile)} className={`rounded-md px-2 py-1 text-[10px] font-semibold ${permissionProfile === profile ? "bg-white text-indigo-600 shadow-sm dark:bg-slate-700" : "text-slate-400"}`}>{profile === "read-only" ? "查看" : "修改"}</button>)}</div>{running ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancel()}><Square size={12} />取消</button> : <button type="button" className="btn btn-primary btn-sm" disabled={!modelId || !prompt.trim() || submitting || (models.find((item) => item.id === modelId)?.engine === "codex-cli" && !selectedModel)} onClick={() => void start()}>{submitting ? <LoaderCircle size={13} className="animate-spin" /> : <SendHorizontal size={14} />}发送</button>}</div></div>{!models.length && <p className="mt-2 text-[10px] text-amber-500">请先在模型设置中添加连接。</p>}{error && <p className="mt-2 rounded-lg bg-red-50 p-2 text-[10px] text-red-600 dark:bg-red-500/10 dark:text-red-300">{error}</p>}</div>
  </div>;
}

function Message({ role, pending = false, elapsed = 0, usage = 0, model, children }: { role: "user" | "assistant"; pending?: boolean; elapsed?: number; usage?: number; model?: string; children: ReactNode }) {
  const user = role === "user";
  return <div className={`flex items-start gap-2.5 ${user ? "flex-row-reverse" : ""}`}><span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-xl ${user ? "bg-slate-800 text-white dark:bg-slate-700" : "border border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900"}`}>{user ? <UserRound size={13} /> : <Bot size={14} />}</span><div className={`max-w-[85%] whitespace-pre-wrap px-3.5 py-2.5 text-[13px] leading-5 shadow-sm ${user ? "rounded-2xl rounded-tr-md bg-slate-100 dark:bg-slate-800" : "rounded-2xl rounded-tl-md"}`}>{pending && <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-300"><LoaderCircle size={12} className="animate-spin" />Working ({formatElapsed(elapsed)})</div>}{children}{!user && (model || usage > 0) && <div className="mt-2 border-t border-slate-200/70 pt-1.5 text-[10px] text-slate-400 dark:border-slate-700/70">{model || "默认模型"}{usage > 0 ? ` · ${formatTokens(usage)} tokens` : ""}</div>}</div></div>;
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}
function taskUsage(task: AgentTask) { return (task.inputTokens || 0) + (task.outputTokens || 0); }
function formatTokens(value: number) { return new Intl.NumberFormat("zh-CN").format(value); }
function effortLabel(value: string) { return ({ low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大", ultra: "极致" } as Record<string, string>)[value] || value; }

function describeTool(event: AgentEvent) {
  const input = event.toolInput && typeof event.toolInput === "object" ? event.toolInput as Record<string, unknown> : {};
  const detail = ["path", "file_path", "command", "query"].map((key) => input[key]).find((value) => typeof value === "string");
  return `${event.toolName || "操作"}${detail ? ` ${String(detail)}` : ""}`;
}
