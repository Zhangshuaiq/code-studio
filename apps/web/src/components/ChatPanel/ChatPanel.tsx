import { useState, useRef, useEffect, FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AgentEvent, streamAgentRun } from "../../lib/agentStream";
import { SessionTask, useSessionTasks } from "../../hooks/useSessionTasks";
import {
  Bot,
  CircleDot,
  LoaderCircle,
  SendHorizontal,
  RotateCcw,
  Square,
  Sparkles,
  UserRound,
} from "lucide-react";
import { api } from "../../lib/api";

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
    "你好 👋 描述你想构建的应用或接口，我会生成代码、记录版本并自动启动预览。\n\n你也可以继续提出修改，例如「给列表加搜索和筛选」，我会在现有项目上迭代。",
};

// 历史任务 → 对话消息
function tasksToMessages(tasks: SessionTask[]): ChatMessage[] {
  return tasks.flatMap((t) => {
    const head =
      t.status === "succeeded" ? "✅ " : ["failed", "cancelled", "timed_out"].includes(t.status) ? "❌ " : "";
    return [
      { id: `${t.id}-u`, role: "user" as const, content: t.prompt },
      {
        id: `${t.id}-a`,
        role: "assistant" as const,
        content: head + (t.resultLog || "(无输出)"),
        taskId: t.id,
        taskStatus: ["cancelled", "timed_out"].includes(t.status) ? "failed" : t.status,
        retryPrompt: t.prompt,
      },
    ];
  });
}

export function ChatPanel({
  sessionId,
  onGenerated,
  readOnly = false,
}: {
  sessionId?: string;
  onGenerated?: () => void;
  readOnly?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
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
    seededFor.current = sessionId;
  }, [sessionId, history.isLoading, history.data]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  function replaceMessage(id: string, patch: Partial<ChatMessage>) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || running || !sessionId || readOnly) return;
    setInput("");
    await executePrompt(text);
  }

  async function executePrompt(text: string) {
    if (!text || running || !sessionId || readOnly) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const pendingId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: pendingId, role: "assistant", content: "正在生成…", pending: true },
    ]);
    setRunning(true);

    let acc = "";
    const render = (extra: string) => {
      acc += extra;
      replaceMessage(pendingId, { content: acc });
    };

    await streamAgentRun(sessionId, text, {
      onQueued: (taskId) => {
        setActiveTaskId(taskId);
        replaceMessage(pendingId, { content: "任务已进入队列，正在等待执行…" });
      },
      onEvent: (ev: AgentEvent) => {
        // text 为流式增量，原样拼接（自身带换行）；结构化事件各占一行
        if (ev.kind === "text" && ev.text) render(ev.text);
        else if (ev.kind === "tool_use")
          render(`\n· ${describeTool(ev.toolName, ev.toolInput)}`);
        else if (ev.kind === "result" && ev.text) render(`\n\n${ev.text}`);
        else if (ev.kind === "system" && ev.text) render(`\n${ev.text}`);
      },
      onDone: (r) => {
        setActiveTaskId(undefined);
        const head =
          r.status === "succeeded"
            ? "✅ 完成，正在启动预览…\n\n"
            : "❌ 生成失败\n\n";
        replaceMessage(pendingId, {
          // 断线恢复后中间增量可能不完整，最终持久化日志才是权威结果。
          content: head + (r.log || acc || ""),
          pending: false,
          taskId: r.taskId,
          taskStatus: r.status,
          retryPrompt: text,
        });
        // 让历史缓存刷新（含刚落库的这条 Task），下次进入该会话可恢复
        qc.invalidateQueries({ queryKey: ["history", sessionId] });
        if (r.status === "succeeded") onGenerated?.();
      },
      onError: (msg) => {
        setActiveTaskId(undefined);
        replaceMessage(pendingId, { content: `❌ ${msg}`, pending: false, taskStatus: "failed", retryPrompt: text });
      },
    });
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

  const disabled = running || !sessionId || readOnly;

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-white to-slate-50/60 dark:from-slate-900 dark:to-slate-950/50">
      <header className="panel flex min-h-[58px] items-center gap-3 border-b px-4">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-[0_8px_18px_-8px_rgba(79,70,229,0.9)]">
          <Sparkles size={17} />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            AI 助手
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
                : "已连接，随时可以开始"}
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 space-y-5 overflow-y-auto px-4 py-5"
      >
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} onRetry={(prompt) => void executePrompt(prompt)} retryDisabled={running || readOnly} />
        ))}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-slate-200/80 bg-white/85 p-3 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/85"
      >
        <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_10px_30px_-18px_rgba(15,23,42,0.45)] transition focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-500/10 dark:border-slate-700 dark:bg-slate-950/70 dark:focus-within:border-indigo-500">
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
                ? "描述你的需求，例如：做一个计数器，点按钮加一…"
                : "正在准备工作区…"
            }
            className="w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
          />
          <div className="mt-1 flex items-center justify-between gap-2 px-1">
            <span className="text-[10px] text-slate-400">
              Enter 发送 · Shift+Enter 换行
            </span>
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
      </form>
    </div>
  );
}

function MessageBubble({ message, onRetry, retryDisabled }: { message: ChatMessage; onRetry: (prompt: string) => void; retryDisabled: boolean }) {
  const isUser = message.role === "user";
  return (
    <div
      className={`flex items-start gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}
    >
      <span
        className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-xl ${
          isUser
            ? "bg-slate-800 text-white dark:bg-slate-700"
            : "bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm"
        }`}
      >
        {isUser ? <UserRound size={13} /> : <Bot size={14} />}
      </span>
      <div
        className={`max-w-[85%] whitespace-pre-wrap px-3.5 py-2.5 text-[13px] leading-5 shadow-sm ${
          isUser
            ? "rounded-2xl rounded-tr-md bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-[0_8px_20px_-12px_rgba(79,70,229,0.8)]"
            : "rounded-2xl rounded-tl-md border border-slate-200/80 bg-white text-slate-700 dark:border-slate-700/80 dark:bg-slate-800/80 dark:text-slate-100"
        } ${message.pending ? "animate-pulse" : "animate-fade-in"}`}
      >
        <div>{message.content}</div>
        {!isUser && message.taskStatus === "failed" && message.retryPrompt && (
          <button type="button" disabled={retryDisabled} onClick={() => onRetry(message.retryPrompt!)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50 dark:border-red-900/60 dark:bg-red-950/30">
            <RotateCcw size={12} />重新执行
          </button>
        )}
      </div>
    </div>
  );
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
