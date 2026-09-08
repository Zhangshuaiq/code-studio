import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Terminal, X } from "lucide-react";
import { api } from "../../lib/api";

interface PreviewStatus {
  status: "none" | "starting" | "ready" | "failed" | "stopped";
  logsTail?: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  none: "未运行",
  starting: "启动中",
  ready: "运行中",
  failed: "失败",
  stopped: "已停止",
};

// 底部运行日志面板：展示预览/dev server 的运行输出
export function LogPanel({
  sessionId,
  onClose,
}: {
  sessionId?: string;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLPreElement>(null);

  const q = useQuery<PreviewStatus>({
    queryKey: ["preview", sessionId],
    enabled: !!sessionId,
    queryFn: async () =>
      (await api.get(`/preview/sessions/${sessionId}/status`)).data,
    refetchInterval: (query) =>
      query.state.data?.status === "starting" ? 1500 : false,
  });

  const logs = q.data?.logsTail ?? "";
  const status = q.data?.status ?? "none";

  // 新日志到达时自动滚到底部
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [logs]);

  return (
    <div className="flex h-full flex-col bg-slate-950">
      <div className="flex min-h-[38px] items-center gap-2 border-b border-slate-800 bg-slate-900 px-3">
        <Terminal size={13} className="text-indigo-400" />
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
          运行日志
        </span>
        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[9px] font-medium text-slate-400">
          {STATUS_LABEL[status]}
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded-lg p-1 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200"
          title="关闭日志面板"
        >
          <X size={14} />
        </button>
      </div>
      <pre
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-auto bg-slate-950 p-4 font-mono text-[11px] leading-5 text-slate-300"
      >
        {logs || "（暂无日志。生成或启动预览后，运行输出会显示在这里。）"}
      </pre>
    </div>
  );
}
