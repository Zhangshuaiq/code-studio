import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  ExternalLink,
  HardDrive,
  Rocket,
  ScrollText,
  Settings,
  Square,
} from "lucide-react";
import {
  useDeployStatus,
  useDeployActions,
  useDeployTargets,
} from "../../hooks/useDeploy";
import { Select } from "../common/Select";

const LABEL: Record<string, string> = {
  none: "未部署",
  building: "构建中…",
  running: "运行中",
  failed: "失败",
  stopped: "已停止",
};
const COLOR: Record<string, string> = {
  none: "bg-slate-300",
  building: "bg-amber-400 animate-pulse",
  running: "bg-green-500",
  failed: "bg-red-500",
  stopped: "bg-slate-400",
};

export function DeployPanel({ sessionId }: { sessionId?: string }) {
  const navigate = useNavigate();
  const q = useDeployStatus(sessionId);
  const { deploy, stop } = useDeployActions(sessionId);
  const targets = useDeployTargets();
  const [showLogs, setShowLogs] = useState(false);
  const [target, setTarget] = useState(""); // 选中的部署目标 id（无内置项，需用户配置）
  const [deployErr, setDeployErr] = useState("");
  const d = q.data;
  const status = d?.status ?? "none";
  const busy = deploy.isPending || stop.isPending || status === "building";
  const runtimeLogs = d?.runtimeLogs || "";
  const targetList = targets.data ?? [];
  const noTargets = targets.isSuccess && targetList.length === 0;
  const selectedTarget = targetList.find((item) => item.id === target);
  const isArtifactTarget = selectedTarget?.kind === "server-artifact";
  const isArtifactDeployment = d?.deploymentKind === "artifact";
  const isArtifactOperation = isArtifactTarget || isArtifactDeployment;
  const statusLabel =
    isArtifactDeployment && status === "running" ? "上传完成" : LABEL[status];

  // 默认选中第一个目标；若当前选中的目标已被删除则回退
  useEffect(() => {
    if (targetList.length && !targetList.some((t) => t.id === target)) {
      setTarget(targetList[0].id);
    }
  }, [targetList, target]);

  function doDeploy() {
    setDeployErr("");
    if (!target) {
      setDeployErr("请先在右上角设置里配置并选择一个部署目标");
      return;
    }
    deploy.mutate(target, {
      onError: (e: any) =>
        setDeployErr(e?.response?.data?.message ?? "部署失败"),
    });
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-slate-900">
      {/* 工具条 */}
      <div className="panel flex min-h-[46px] items-center gap-2 border-b px-3">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
          <Rocket size={14} />
        </span>
        <span className={`h-2 w-2 rounded-full ${COLOR[status]}`} />
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          {statusLabel}
        </span>
        {d?.gitSha && (
          <span className="rounded-full bg-slate-100 px-2 py-1 font-mono text-[9px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {d.gitSha.slice(0, 7)}
          </span>
        )}
        {d?.url && status === "running" && (
          <a
            href={d.url}
            target="_blank"
            rel="noreferrer"
            className="ml-1 inline-flex max-w-[240px] items-center gap-1 truncate rounded-full bg-indigo-50 px-2.5 py-1 font-mono text-[10px] text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300"
          >
            {d.url} <ExternalLink size={12} />
          </a>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* 目标选择器 */}
          <Select
            value={target}
            onChange={setTarget}
            disabled={busy || noTargets}
            options={
              noTargets
                ? [{ value: "", label: "未配置目标" }]
                : targetList.map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))
            }
            size="sm"
            className="w-40"
            buttonClassName="text-[11px] font-medium"
            title="部署目标"
          />
          <button
            onClick={() => navigate("/settings/deploy-targets")}
            className="btn btn-ghost btn-sm"
            title="配置部署目标"
          >
            <Settings size={15} />
          </button>
          {status === "running" && !isArtifactDeployment && (
            <button
              onClick={() => setShowLogs((v) => !v)}
              className={`btn btn-sm ${showLogs ? "btn-primary" : "btn-ghost"}`}
              title="容器运行日志"
            >
              <ScrollText size={12} /> 运行日志
            </button>
          )}
          <button
            onClick={doDeploy}
            disabled={busy || !target}
            title={!target ? "请先配置部署目标" : undefined}
            className="btn btn-primary btn-sm"
          >
            {status === "building"
              ? isArtifactOperation
                ? "上传中…"
                : "构建中…"
              : status === "running"
                ? isArtifactTarget
                  ? "重新上传"
                  : "重新部署"
                : isArtifactTarget
                  ? "构建并上传"
                  : "部署"}
          </button>
          {(status === "running" || status === "building") &&
            !isArtifactDeployment &&
            !isArtifactTarget && (
              <button
                onClick={() => stop.mutate()}
                disabled={stop.isPending}
                className="btn btn-ghost btn-sm"
              >
                <Square size={11} /> 停止
              </button>
            )}
        </div>
      </div>

      {/* 主体：运行中默认 iframe，可切"运行日志"；构建/失败看日志 */}
      <div className="min-h-0 flex-1">
        {status === "running" && isArtifactDeployment ? (
          <div className="flex h-full flex-col gap-4 overflow-auto bg-slate-50/60 p-5 dark:bg-slate-950/30">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-5 dark:border-emerald-500/20 dark:bg-emerald-500/5">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
                  <CheckCircle2 size={20} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                    构建产物已上传到服务器
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-emerald-700 dark:text-emerald-300">
                    {d.targetName || "目标服务器"}
                  </p>
                  {d.artifactPath && (
                    <div className="mt-3 flex items-center gap-2 rounded-xl bg-white/70 px-3 py-2 font-mono text-[11px] text-slate-700 dark:bg-slate-950/40 dark:text-slate-200">
                      <HardDrive size={13} className="shrink-0" />
                      <span className="break-all">{d.artifactPath}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            {d.logsTail && (
              <pre className="min-h-[180px] flex-1 overflow-auto rounded-2xl border border-slate-800 bg-slate-950 p-4 font-mono text-[11px] leading-5 text-slate-200 shadow-xl">
                {d.logsTail}
              </pre>
            )}
          </div>
        ) : status === "running" && d?.url && !showLogs ? (
          <iframe
            src={d.url}
            title="deployment"
            className="h-full w-full border-0 bg-white"
          />
        ) : status === "running" && showLogs ? (
          <pre className="h-full overflow-auto bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-200">
            {runtimeLogs || "（暂无运行日志）"}
          </pre>
        ) : (
          <div className="flex h-full flex-col gap-4 bg-slate-50/60 p-5 dark:bg-slate-950/30">
            {noTargets && status !== "building" ? (
              <div className="surface-soft border-dashed p-5 text-sm leading-6 text-muted">
                还没有部署目标。点右上角
                <Settings size={13} className="mx-1 inline align-text-bottom" />
                添加一个（Docker 主机 / SSH / Kubernetes
                集群），填好连接信息与备注名后即可部署。
              </div>
            ) : (
              <p className="text-sm text-muted">
                {status === "building"
                  ? isArtifactOperation
                    ? "正在 Maven 构建并通过 SFTP 上传 JAR/WAR，下方是实时进度…"
                    : "正在构建生产镜像并启动容器（首次较慢），下方是实时构建日志…"
                  : status === "failed"
                    ? "部署失败，下方日志含构建错误 / 容器崩溃原因"
                    : status === "stopped"
                      ? "已停止。点「部署」重新上线。"
                      : "把当前项目构建成生产镜像并部署为持久实例（区别于开发预览）。选择目标后点「部署」开始。"}
              </p>
            )}
            {(d?.logsTail || runtimeLogs) && (
              <pre className="min-h-0 flex-1 overflow-auto rounded-2xl border border-slate-800 bg-slate-950 p-4 font-mono text-[11px] leading-5 text-slate-200 shadow-xl">
                {d?.logsTail || runtimeLogs}
              </pre>
            )}
          </div>
        )}
      </div>

      {deployErr && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400">
          {deployErr}
        </div>
      )}
    </div>
  );
}
