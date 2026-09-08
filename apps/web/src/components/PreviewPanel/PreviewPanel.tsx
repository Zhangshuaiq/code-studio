import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  MonitorUp,
  Play,
  RefreshCw,
  RotateCw,
  Square,
} from "lucide-react";
import { api } from "../../lib/api";
import { ApiTester } from "./ApiTester";
import { useFeedback } from "../common/FeedbackProvider";
import { errText } from "../Settings/ui";

interface PreviewStatus {
  status: "none" | "starting" | "ready" | "failed" | "stopped";
  url?: string | null;
  logsTail?: string | null;
  kind?: string | null;
  targetName?: string | null;
  teamId?: string | null;
  requirementId?: string | null;
  webrtcEndpoint?: string | null;
  extra?: { deviceProfile?: string; runtimeKind?: string;requirementNo?:string;serviceKey?:string;fallbackEnvironment?:string } | null;
}

interface RequirementOption { id:string;title:string;requirementNo:string;currentStage:string;status:string;_count:{projects:number;previews:number} }
interface RequirementList { items:RequirementOption[];total:number }

interface BuildMetrics {
  completed: number;
  successRate: number;
  averageDurationMs: number;
}

const STATUS_LABEL: Record<PreviewStatus["status"], string> = {
  none: "未启动",
  starting: "启动中…",
  ready: "运行中",
  failed: "启动失败",
  stopped: "已停止",
};

const STATUS_COLOR: Record<PreviewStatus["status"], string> = {
  none: "bg-slate-300",
  starting: "bg-amber-400 animate-pulse",
  ready: "bg-green-500",
  failed: "bg-red-500",
  stopped: "bg-slate-400",
};

export function PreviewPanel({
  sessionId,
  generationSeq = 0,
}: {
  sessionId: string;
  generationSeq?: number;
}) {
  const qc = useQueryClient();
  const { toast } = useFeedback();
  const [iframeKey, setIframeKey] = useState(0);
  const [requirementId,setRequirementId]=useState("");
  // 生成后进入「等待预览」窗口：即便当前是 none/stopped 也持续轮询，
  // 直到 PreviewInstance 出现并 ready/failed，或超时（避免空闲时无意义轮询）
  const [awaitUntil, setAwaitUntil] = useState(0);
  const lastSeq = useRef(generationSeq);
  useEffect(() => {
    if (generationSeq !== lastSeq.current) {
      lastSeq.current = generationSeq;
      setAwaitUntil(Date.now() + 90_000);
    }
  }, [generationSeq]);

  const statusQuery = useQuery<PreviewStatus>({
    queryKey: ["preview", sessionId],
    queryFn: async () =>
      (await api.get(`/preview/sessions/${sessionId}/status`)).data,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s === "starting") return 2000;
      if (s === "ready" || s === "failed") return false;
      // none/stopped：仅在生成后的等待窗口内轮询
      return Date.now() < awaitUntil ? 2000 : false;
    },
  });

  const start = useMutation({
    mutationFn: () => api.post(`/preview/sessions/${sessionId}/start`, { requirementId: requirementId || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["preview", sessionId] }),
    onError: (error) =>
      toast(errText(error), { title: "无法启动预览", tone: "error" }),
  });
  const stop = useMutation({
    mutationFn: () => api.post(`/preview/sessions/${sessionId}/stop`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["preview", sessionId] }),
    onError: (error) =>
      toast(errText(error), { title: "无法停止预览", tone: "error" }),
  });

  const data = statusQuery.data;
  useEffect(()=>{if(data?.requirementId)setRequirementId(data.requirementId);},[data?.requirementId]);
  const requirements=useQuery<RequirementList>({queryKey:["requirements","preview",data?.teamId],enabled:!!data?.teamId,queryFn:async()=>(await api.get('/requirements',{params:{teamId:data!.teamId,pageSize:100}})).data});
  const buildMetrics = useQuery<BuildMetrics>({
    queryKey: ["preview-build-metrics", sessionId],
    enabled: data?.extra?.runtimeKind === "k8s",
    queryFn: async () => (await api.get(`/preview/sessions/${sessionId}/builds/metrics`, { params: { days: 7 } })).data,
  });
  const status = data?.status ?? "none";
  const url = data?.url ?? undefined;
  const isBackend = data?.kind === "http-service";
  const isEmulator = data?.kind === "emulator";
  const running = status === "starting" || status === "ready";
  const busy = start.isPending || stop.isPending;
  // 生成后、预览实例尚未出现的等待窗口
  const awaiting =
    (status === "none" || status === "stopped") && Date.now() < awaitUntil;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-slate-900">
      {/* 工具条 */}
      <div className="panel flex min-h-[46px] items-center gap-2 border-b px-3">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
          <MonitorUp size={14} />
        </span>
        <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[status]}`} />
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          {STATUS_LABEL[status]}
        </span>
        {data?.targetName && (
          <span className="rounded-full bg-indigo-50 px-2 py-1 text-[9px] font-medium text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
            {data.targetName}
          </span>
        )}
        {!!buildMetrics.data?.completed && (
          <span className="rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" title={`平均构建 ${(buildMetrics.data.averageDurationMs / 1000).toFixed(1)} 秒`}>
            7日构建成功率 {buildMetrics.data.successRate.toFixed(1)}%
          </span>
        )}
        {url && status === "ready" && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="ml-1 inline-flex max-w-[260px] items-center gap-1 truncate rounded-full bg-slate-100 px-2.5 py-1 font-mono text-[10px] text-muted hover:text-indigo-600 dark:bg-slate-800 dark:hover:text-indigo-300"
          >
            {url} <ExternalLink size={12} />
          </a>
        )}

        <div className="ml-auto flex items-center gap-2">
          {!running && (
            <button
              onClick={() => start.mutate()}
              disabled={busy}
              className="btn btn-primary btn-sm"
            >
              <Play size={12} /> 部署预览
            </button>
          )}
          {running && (
            <>
              <button
                onClick={() => start.mutate()}
                disabled={busy}
                className="btn btn-ghost btn-sm"
              >
                <RotateCw size={12} /> 重新部署
              </button>
              <button
                onClick={() => stop.mutate()}
                disabled={busy}
                className="btn btn-ghost btn-sm"
              >
                <Square size={11} /> 停止
              </button>
            </>
          )}
          {status === "ready" && (
            <button
              onClick={() => setIframeKey((k) => k + 1)}
              disabled={busy}
              className="btn btn-ghost btn-sm"
              title="刷新预览"
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>
      </div>

      {data?.teamId && (
        <div className="panel flex min-h-[48px] flex-wrap items-center gap-2 border-b px-3">
          <span className="text-[10px] font-bold text-muted">关联需求</span>
          <select className="input h-8 min-w-48 flex-1 py-1 text-xs" value={requirementId} disabled={running} onChange={event=>setRequirementId(event.target.value)}>
            <option value="">独立预览（不参与需求联调）</option>
            {requirements.data?.items.filter(requirement=>['draft','active'].includes(requirement.status)).map(requirement=><option key={requirement.id} value={requirement.id}>{requirement.requirementNo} · {requirement.title} · {requirement._count.previews} 个预览服务</option>)}
          </select>
          {data.extra?.requirementNo&&<span className="rounded-full bg-indigo-50 px-2 py-1 font-mono text-[9px] text-indigo-600 dark:bg-indigo-500/10">{data.extra.requirementNo} · {data.extra.serviceKey} · 未覆盖服务回落 {data.extra.fallbackEnvironment}</span>}
        </div>
      )}

      {/* 预览主体 */}
      <div className="min-h-0 flex-1">
        {isEmulator ? (
          <CloudPhone
            status={status}
            endpoint={data?.webrtcEndpoint}
            iframeKey={iframeKey}
            deviceProfile={data?.extra?.deviceProfile}
          />
        ) : status === "ready" && isBackend ? (
          <ApiTester sessionId={sessionId} />
        ) : status === "ready" && url ? (
          <iframe
            key={iframeKey}
            src={url}
            title="preview"
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="relative flex h-full flex-col items-center justify-center gap-4 overflow-hidden bg-slate-50/70 p-6 text-center dark:bg-slate-950/35">
            <div className="pointer-events-none absolute h-72 w-72 rounded-full bg-indigo-400/5 blur-3xl" />
            <span className="relative grid h-16 w-16 place-items-center rounded-2xl border border-slate-200 bg-white text-indigo-500 shadow-[0_12px_30px_-18px_rgba(79,70,229,0.5)] dark:border-slate-700 dark:bg-slate-900">
              {status === "starting" || awaiting ? (
                <RefreshCw size={25} className="animate-spin" />
              ) : (
                <MonitorUp size={26} />
              )}
            </span>
            <p className="relative max-w-md text-sm font-medium text-slate-600 dark:text-slate-300">
              {status === "starting" || awaiting
                ? isEmulator
                  ? "正在启动云手机、构建并安装 Android 应用，请稍候…"
                  : "正在安装依赖并启动 dev server，请稍候…"
                : status === "failed"
                  ? "启动失败，请查看日志后重试"
                  : "选择联调环境后点击「部署预览」；未选择时使用独立预览"}
            </p>
            {(status === "starting" || status === "failed") &&
              data?.logsTail && (
                <pre className="relative max-h-64 w-full max-w-2xl overflow-auto rounded-2xl border border-slate-800 bg-slate-950 p-4 text-left font-mono text-xs leading-5 text-slate-300 shadow-xl">
                  {data.logsTail}
                </pre>
              )}
          </div>
        )}
      </div>
    </div>
  );
}

function CloudPhone({
  status,
  endpoint,
  iframeKey,
  deviceProfile,
}: {
  status: PreviewStatus["status"];
  endpoint?: string | null;
  iframeKey: number;
  deviceProfile?: string;
}) {
  const connected = status === "ready" && !!endpoint;
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_50%_25%,rgba(99,102,241,0.12),transparent_36%),linear-gradient(145deg,#f8fafc,#eef2ff)] p-5 dark:bg-[radial-gradient(circle_at_50%_25%,rgba(99,102,241,0.14),transparent_36%),linear-gradient(145deg,#020617,#0f172a)]">
      <div className="absolute h-[70%] w-48 rounded-full bg-indigo-400/10 blur-3xl" />
      <div className="relative h-[calc(100%-1rem)] min-h-[360px] max-h-[780px] aspect-[9/19.5] rounded-[3rem] bg-gradient-to-br from-slate-700 via-slate-950 to-black p-[7px] shadow-[0_35px_80px_-28px_rgba(15,23,42,0.8),0_0_0_1px_rgba(255,255,255,0.12)]">
        <span className="absolute -left-[3px] top-28 h-12 w-[3px] rounded-l bg-slate-700" />
        <span className="absolute -left-[3px] top-44 h-16 w-[3px] rounded-l bg-slate-700" />
        <span className="absolute -right-[3px] top-36 h-20 w-[3px] rounded-r bg-slate-700" />
        <div className="relative h-full overflow-hidden rounded-[2.55rem] bg-black ring-1 ring-white/10">
          <div className="pointer-events-none absolute left-1/2 top-2 z-20 flex h-6 w-24 -translate-x-1/2 items-center justify-center rounded-full bg-black shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-slate-800 ring-1 ring-slate-700" />
          </div>
          {connected ? (
            <iframe
              key={iframeKey}
              src={endpoint}
              title={`云手机 ${deviceProfile ?? "Android"}`}
              allow="autoplay; clipboard-read; clipboard-write"
              className="h-full w-full border-0 bg-black"
            />
          ) : status === "starting" ? (
            <div className="flex h-full items-center justify-center bg-black">
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/15 border-t-white/70" />
            </div>
          ) : (
            <div className="h-full bg-black" aria-label="云手机未启动" />
          )}
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-20 h-1 w-24 -translate-x-1/2 rounded-full bg-white/35" />
        </div>
      </div>
    </div>
  );
}
