import { useState, useRef, useEffect, FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AgentEvent, streamAgentRun, watchAgentTask } from "../../lib/agentStream";
import { SessionTask, useSessionTasks } from "../../hooks/useSessionTasks";
import {
  Bot,
  CircleDot,
  LoaderCircle,
  SendHorizontal,
  RotateCcw,
  Square,
  UserRound,
} from "lucide-react";
import { api } from "../../lib/api";
import { ModelSwitcher } from "../ModelSettings/ModelSwitcher";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  taskId?: string;
  taskStatus?: string;
  retryPrompt?: string;
}

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "描述你希望完成的开发任务。我会先查看当前项目，再按需修改文件。你可以在下方选择平台和模型。",
};

function cleanLegacyClusterNotice(log: string) {
  return log.replace(/\n*⚠ 当前未连接集群：已保存代码，未执行自动构建验证或预览。/g, "").trim();
}

// 历史任务 → 对话消息
function tasksToMessages(tasks: SessionTask[]): ChatMessage[] {
  return tasks.flatMap((t) => {
    const active = ['queued', 'running', 'cancelling'].includes(t.status);
    const head =
      t.status === "succeeded" ? "✅ " : ["failed", "cancelled", "timed_out"].includes(t.status) ? "❌ " : "";
    return [
      { id: `${t.id}-u`, role: "user" as const, content: t.prompt },
      {
        id: `${t.id}-a`,
        role: "assistant" as const,
        content: active ? '' : head + (cleanLegacyClusterNotice(t.resultLog || "") || "(无输出)"),
        pending: active,
        taskId: t.id,
        taskStatus: ["cancelled", "timed_out"].includes(t.status) ? "failed" : t.status,
        retryPrompt: t.prompt,
      },
    ];
  });
}

export function ChatPanel({
  sessionId,
  initialModelConfigId,
  initialModelName,
  onGenerated,
  readOnly = false,
}: {
  sessionId?: string;
  initialModelConfigId?: string | null;
  initialModelName?: string | null;
  onGenerated?: () => void;
  readOnly?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  // 恢复历史对话：会话切换时用历史任务重新填充（每个会话只填一次，避免冲掉正在流式的消息）
  const history = useSessionTasks(sessionId);
  const seededFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!sessionId || history.isLoading) return;
    if (seededFor.current === sessionId) return;
    const msgs = tasksToMessages(history.data ?? []);
    setMessages(msgs.length ? msgs : [WELCOME]);
    setRunning(false);
    setActiveTaskId(undefined);
    setStartedAt(undefined);
    seededFor.current = sessionId;
  }, [sessionId, history.isLoading, history.data]);

  useEffect(() => {
    if (!sessionId || !history.data || seededFor.current !== sessionId) return;
    const active = [...(history.data ?? [])].reverse().find((task) => ['queued', 'running', 'cancelling'].includes(task.status));
    if (!active) return;
    const controller = new AbortController();
    setActiveTaskId(active.id);
    setStartedAt(new Date(active.startedAt || active.createdAt).getTime());
    setRunning(true);
    void watchAgentTask(active.id, taskHandlers(`${active.id}-a`, active.prompt), controller.signal).finally(() => {
      if (!controller.signal.aborted) setRunning(false);
    });
    return () => controller.abort();
  }, [sessionId, history.data]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  useEffect(() => {
    if (!running || !startedAt) return;
    const update = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  function replaceMessage(id: string, patch: Partial<ChatMessage>) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );
  }

  function taskHandlers(pendingId: string, text: string) {
    let acc = "";
    let reasoningActive = false;
    const render = (extra: string) => {
      acc += extra;
      replaceMessage(pendingId, { content: acc });
    };
    return {
      onQueued: (taskId: string) => setActiveTaskId(taskId),
      onEvent: (ev: AgentEvent) => {
        if (ev.kind === 'system' && ev.text === '任务已开始，正在准备工作区…') return;
        if (ev.kind === 'reasoning' && ev.text) {
          render(`${reasoningActive ? '' : `${acc ? '\n\n' : ''}思考摘要：`}${ev.text}`);
          reasoningActive = true;
        } else if (ev.kind === 'text' && ev.text) {
          reasoningActive = false;
          render(ev.text);
        } else if (ev.kind === 'tool_use') {
          reasoningActive = false;
          render(`\n· ${describeTool(ev.toolName, ev.toolInput)}`);
        } else if (ev.kind === 'result' && ev.text) render(`\n\n${ev.text}`);
        else if (ev.kind === 'system' && ev.text) render(`${acc ? '\n' : ''}${ev.text}`);
      },
      onDone: (r: { taskId: string; status: 'succeeded' | 'failed'; log: string }) => {
        setActiveTaskId(undefined);
        setRunning(false);
        replaceMessage(pendingId, {
          content: `${r.status === 'succeeded' ? '✅ 完成\n\n' : '❌ 生成失败\n\n'}${cleanLegacyClusterNotice(r.log || '') || acc || ''}`,
          pending: false,
          taskId: r.taskId,
          taskStatus: r.status,
          retryPrompt: text,
        });
        qc.invalidateQueries({ queryKey: ['history', sessionId] });
        if (r.status === 'succeeded') onGenerated?.();
      },
      onError: (msg: string) => {
        setActiveTaskId(undefined);
        setRunning(false);
        replaceMessage(pendingId, { content: `❌ ${msg}`, pending: false, taskStatus: 'failed', retryPrompt: text });
      },
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || running || !sessionId || readOnly || !modelReady) return;
    setInput("");
    await executePrompt(text);
  }

  async function executePrompt(text: string) {
    if (!text || running || !sessionId || readOnly || !modelReady) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const pendingId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: pendingId, role: "assistant", content: "", pending: true },
    ]);
    setStartedAt(Date.now());
    setElapsedSeconds(0);
    setRunning(true);

    await streamAgentRun(sessionId, text, taskHandlers(pendingId, text));
    setRunning(false);
  }

  async function cancelTask() {
    if (!activeTaskId) return;
    try {
      await api.post(`/agent/tasks/${activeTaskId}/cancel`);
    } catch {
      // 活跃任务不能强杀，后端会保留任务并由原 SSE 返回具体错误。
    }
  }

  const disabled = running || !sessionId || readOnly || !modelReady;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-slate-950">
      <header className="flex min-h-[58px] items-center gap-3 border-b border-slate-200 px-4 dark:border-slate-800">
        <span className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
          <Bot size={17} />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            项目对话
          </h2>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400">
            <CircleDot
              size={9}
              className={running ? "text-amber-500" : "text-emerald-500"}
            />
            {readOnly
              ? "只读成员，可查看历史"
              : running
                ? "正在执行任务"
                : modelReady ? "就绪" : "请选择模型"}
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 space-y-5 overflow-y-auto px-4 py-5"
      >
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} elapsed={elapsedSeconds} onRetry={(prompt) => void executePrompt(prompt)} retryDisabled={running || readOnly} />
        ))}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-slate-200/80 bg-white p-3 dark:border-slate-800 dark:bg-slate-950"
      >
        <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm transition focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-200/60 dark:border-slate-700 dark:bg-slate-900 dark:focus-within:border-slate-500">
          <textarea
            value={input}
            disabled={readOnly}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            rows={3}
            placeholder={
              readOnly
                ? "当前项目角色为只读，不能发起代码生成"
                : sessionId
                ? "向智能体描述你的任务…"
                : "正在准备工作区…"
            }
            className="w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
          />
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 px-1">
            <ModelSwitcher sessionId={sessionId} initialConfigId={initialModelConfigId} initialModelName={initialModelName} disabled={running || readOnly} onReady={setModelReady}/>
            {running && activeTaskId ? (
              <button type="button" onClick={cancelTask} className="btn btn-ghost btn-sm shrink-0 rounded-xl px-3" title="取消当前任务"><Square size={12} />取消任务</button>
            ) : (
              <button type="submit" className="btn btn-primary btn-sm shrink-0 rounded-xl px-3" disabled={disabled || !input.trim()} title="发送需求">
                {running ? <LoaderCircle size={14} className="animate-spin" /> : <SendHorizontal size={14} />}
                {running ? "排队中" : "发送"}
              </button>
            )}
          </div>
        </div>
        <p className="mt-1 px-1 text-[10px] text-slate-400">Enter 发送 · Shift+Enter 换行 · 使用个人 API 额度</p>
      </form>
    </div>
  );
}

function MessageBubble({ message, elapsed, onRetry, retryDisabled }: { message: ChatMessage; elapsed: number; onRetry: (prompt: string) => void; retryDisabled: boolean }) {
  const isUser = message.role === "user";
  return (
    <div
      className={`flex items-start gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}
    >
      <span
        className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-xl ${
          isUser
            ? "bg-slate-800 text-white dark:bg-slate-700"
            : "border border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
        }`}
      >
        {isUser ? <UserRound size={13} /> : <Bot size={14} />}
      </span>
      <div
        className={`max-w-[85%] whitespace-pre-wrap px-3.5 py-2.5 text-[13px] leading-5 shadow-sm ${
          isUser
            ? "rounded-2xl rounded-tr-md bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
            : "rounded-2xl rounded-tl-md text-slate-700 dark:text-slate-100"
        } ${message.pending ? "" : "animate-fade-in"}`}
      >
        {message.pending && (
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-300">
            <LoaderCircle size={12} className="animate-spin" /> Working ({formatElapsed(elapsed)})
          </div>
        )}
        {!!message.content && <div>{message.content}</div>}
        {!isUser && message.taskStatus === "failed" && message.retryPrompt && (
          <button type="button" disabled={retryDisabled} onClick={() => onRetry(message.retryPrompt!)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50 dark:border-red-900/60 dark:bg-red-950/30">
            <RotateCcw size={12} />重新执行
          </button>
        )}
      </div>
    </div>
  );
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes ? `${minutes}m ${remaining}s` : `${remaining}s`;
}

// 从工具入参里挑一个可读字段（路径 / 命令 / 关键词）
function pick(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

// 把工具事件翻译成一句中文动作描述，例如「读取文件 src/App.tsx」
function describeTool(toolName?: string, input?: unknown): string {
  const name = (toolName ?? "").toLowerCase();
  const path = pick(input, [
    "path",
    "file_path",
    "filePath",
    "filename",
    "file",
  ]);
  const cmd = pick(input, ["command", "cmd", "script"]);
  const pattern = pick(input, ["pattern", "query", "q", "regex"]);
  const at = (p?: string) => (p ? ` ${clip(p)}` : "");

  if (/(read|cat|open|view|get_file)/.test(name)) return `读取文件${at(path)}`;
  if (/(create|new_file)/.test(name)) return `新建文件${at(path)}`;
  if (/(write|save)/.test(name)) return `写入文件${at(path)}`;
  if (/(edit|replace|patch|modify|update)/.test(name))
    return `修改文件${at(path)}`;
  if (/(delete|remove|rm|unlink)/.test(name)) return `删除文件${at(path)}`;
  if (/(bash|exec|shell|run|command|terminal)/.test(name))
    return `执行命令${at(cmd)}`;
  if (/(list|ls|dir|tree|glob)/.test(name)) return `浏览目录${at(path)}`;
  if (/(search|grep|find|ripgrep|rg)/.test(name))
    return `搜索${pattern ? ` ${clip(pattern)}` : ""}`;

  // 兜底：能提取到路径/命令就带上，否则用工具名 + 精简入参
  const detail = path ?? cmd ?? pattern;
  return detail
    ? `${toolName ?? "操作"} ${clip(detail)}`
    : `执行 ${toolName ?? "操作"}`;
}

// 路径/命令过长时截断，保留结尾（结尾往往是文件名，信息量更大）
function clip(s: string, max = 60): string {
  return s.length > max ? "…" + s.slice(-(max - 1)) : s;
}
