import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  GitBranch,
  GitMerge,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useBranches,
  useBranchOps,
  usePush,
  useRemote,
  useRemoteSyncOps,
  useRemoteSyncStatus,
} from "../../hooks/useGit";
import { api } from "../../lib/api";
import { useEditorTabs, type EditorDraft } from "../../store/editorTabs";
import { useFeedback } from "../common/FeedbackProvider";
import { ConflictResolverModal } from "../HistoryPanel/ConflictResolverModal";
import { GitRemoteModal } from "../HistoryPanel/GitRemoteModal";

type PendingOperation =
  | { kind: "checkout"; branch: string }
  | { kind: "create"; branch: string }
  | { kind: "sync" };

type DraftStrategy = "keep" | "save" | "discard";

function errorMessage(error: any) {
  const value =
    error?.response?.data?.message ?? error?.message ?? String(error);
  return Array.isArray(value) ? value.join("；") : value;
}

export function BranchControl({
  sessionId,
  readOnly = false,
}: {
  sessionId?: string;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const { confirm: askConfirm, prompt: askPrompt, toast } = useFeedback();
  const branches = useBranches(sessionId);
  const branchOps = useBranchOps(sessionId);
  const remote = useRemote(sessionId);
  const syncStatus = useRemoteSyncStatus(sessionId);
  const syncOps = useRemoteSyncOps(sessionId);
  const push = usePush(sessionId);
  const drafts = useEditorTabs((state) => state.drafts);
  const markDraftSaved = useEditorTabs((state) => state.markDraftSaved);
  const discardDrafts = useEditorTabs((state) => state.discardDrafts);
  const resetForBranch = useEditorTabs((state) => state.resetForBranch);

  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [popupPosition, setPopupPosition] = useState({
    left: 12,
    bottom: 12,
    width: 390,
    maxHeight: 640,
  });
  const [filter, setFilter] = useState("");
  const [showRemote, setShowRemote] = useState(false);
  const [showResolver, setShowResolver] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation>();
  const [operationBusy, setOperationBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [canForce, setCanForce] = useState(false);

  const currentBranch = branches.data?.current ?? syncStatus.data?.branch;
  const conflicts = syncStatus.data?.conflicts ?? [];
  const mergeInProgress = !!syncStatus.data?.mergeInProgress;
  const dirtyEntries = useMemo(
    () =>
      Object.entries(drafts).filter(
        ([, draft]) => draft.content !== draft.baseline,
      ),
    [drafts],
  );
  const filteredBranches = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    return (branches.data?.list ?? []).filter((branch) =>
      keyword ? branch.toLowerCase().includes(keyword) : true,
    );
  }, [branches.data?.list, filter]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // 菜单使用 body 顶层 fixed 浮层，避免代码区 resize handle 穿透或盖住菜单。
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(390, window.innerWidth - 24);
      const left = Math.min(
        Math.max(12, rect.left),
        window.innerWidth - width - 12,
      );
      setPopupPosition({
        left,
        bottom: Math.max(12, window.innerHeight - rect.top + 8),
        width,
        maxHeight: Math.max(160, rect.top - 20),
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const observer = new ResizeObserver(updatePosition);
    if (rootRef.current) observer.observe(rootRef.current);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      observer.disconnect();
    };
  }, [open]);

  function resetMessage() {
    setNotice("");
    setError("");
    setCanForce(false);
  }

  async function saveDirtyFiles(
    entries: Array<[string, EditorDraft]> = dirtyEntries,
  ) {
    for (const [path, draft] of entries) {
      await api.put(`/sessions/${sessionId}/files/content`, {
        path,
        content: draft.content,
      });
      markDraftSaved(path, draft.content);
      qc.invalidateQueries({ queryKey: ["file", sessionId, path] });
    }
    qc.invalidateQueries({ queryKey: ["files", sessionId] });
    qc.invalidateQueries({ queryKey: ["changes", sessionId] });
    qc.invalidateQueries({ queryKey: ["preview", sessionId] });
  }

  async function refreshWorkspaceFiles() {
    try {
      const response = await api.get<string[]>(`/sessions/${sessionId}/files`);
      resetForBranch(response.data);
    } catch {
      // 分支已经切换时必须清掉旧分支草稿；文件树查询会自行重新加载。
      discardDrafts();
    }
  }

  async function executeOperation(
    operation: PendingOperation,
    strategy: DraftStrategy,
  ) {
    const entries = dirtyEntries;
    setOperationBusy(true);
    resetMessage();
    try {
      if (strategy === "save") await saveDirtyFiles(entries);

      if (operation.kind === "checkout") {
        await branchOps.checkout.mutateAsync(operation.branch);
        await refreshWorkspaceFiles();
        setNotice(`已切换到 ${operation.branch}`);
      } else if (operation.kind === "create") {
        await branchOps.create.mutateAsync(operation.branch);
        await refreshWorkspaceFiles();
        setNotice(`已创建并切换到 ${operation.branch}`);
      } else {
        const result = await syncOps.sync.mutateAsync();
        await refreshWorkspaceFiles();
        if (result.status === "conflict") {
          setOpen(false);
          setShowResolver(true);
          toast("远端与当前分支存在冲突，已打开三列合并器。", {
            title: "需要人工合并",
            tone: "warning",
          });
        } else {
          setNotice("已同步远端最新代码");
        }
      }

      // 放弃策略只在操作成功后清理，切换失败时仍保留用户草稿。
      if (strategy === "discard") discardDrafts();
      setPendingOperation(undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOperationBusy(false);
    }
  }

  function requestOperation(operation: PendingOperation) {
    if (dirtyEntries.length) {
      setOpen(false);
      setPendingOperation(operation);
    } else {
      void executeOperation(operation, "keep");
    }
  }

  async function handleCreateBranch() {
    setOpen(false);
    const name = await askPrompt({
      title: "新建分支",
      message: `从 ${currentBranch ?? "当前分支"} 创建并切换到新分支。`,
      placeholder: "例如 feature/user-profile",
      confirmText: "继续",
      validate: (value) => (value.trim() ? undefined : "请输入分支名称"),
    });
    if (name?.trim()) {
      requestOperation({ kind: "create", branch: name.trim() });
    }
  }

  async function handleDeleteBranch(branch: string) {
    setOpen(false);
    if (
      !(await askConfirm({
        title: "删除分支",
        message: `确认删除本地分支 ${branch}？未合并的提交可能无法再访问。`,
        confirmText: "删除分支",
        tone: "danger",
      }))
    ) {
      return;
    }
    resetMessage();
    try {
      await branchOps.remove.mutateAsync(branch);
      setNotice(`已删除 ${branch}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function handleSync() {
    if (!remote.data?.hasCredential) {
      setOpen(false);
      setShowRemote(true);
      return;
    }
    requestOperation({ kind: "sync" });
  }

  async function handlePush(force = false) {
    resetMessage();
    if (!remote.data?.hasCredential) {
      setOpen(false);
      setShowRemote(true);
      return;
    }
    try {
      if (dirtyEntries.length) {
        setOpen(false);
        const shouldSave = await askConfirm({
          title: "保存后推送",
          message: `${dirtyEntries.length} 个文件尚未保存。需要先保存这些修改，才能包含在本次推送中。`,
          confirmText: "保存并推送",
        });
        if (!shouldSave) return;
        await saveDirtyFiles(dirtyEntries);
      }
      const result = await push.mutateAsync(force);
      setNotice(`已推送到 ${result.branch}`);
    } catch (e: any) {
      setError(errorMessage(e));
      if (e?.response?.data?.rejected) setCanForce(true);
    }
  }

  async function handleAbortMerge() {
    setOpen(false);
    if (
      !(await askConfirm({
        title: "放弃本次合并",
        message: "当前冲突处理结果将被丢弃，工作区恢复到同步前。",
        confirmText: "放弃合并",
        tone: "danger",
      }))
    ) {
      return;
    }
    try {
      await syncOps.abortMerge.mutateAsync();
      await refreshWorkspaceFiles();
      setNotice("已放弃本次合并");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function handleContinueMerge() {
    try {
      await syncOps.continueMerge.mutateAsync();
      setNotice("合并已完成并创建提交");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const branchBusy =
    operationBusy ||
    branchOps.checkout.isPending ||
    branchOps.create.isPending ||
    branchOps.remove.isPending;

  return (
    <>
      <div
        ref={rootRef}
        className="relative shrink-0 border-t border-slate-200 bg-slate-50/95 p-2 dark:border-slate-800 dark:bg-slate-950/80"
      >
        <button
          onClick={() => setOpen((value) => !value)}
          disabled={!sessionId}
          className={`flex w-full min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-semibold transition ${
            mergeInProgress
              ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
              : open
                ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
                : "border-slate-200 bg-white/70 text-slate-600 hover:border-indigo-200 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300"
          }`}
          title={`当前 Git 分支：${currentBranch ?? "读取中"}`}
        >
          <GitBranch size={14} className="shrink-0" />
          <span className="truncate">{currentBranch ?? "读取分支…"}</span>
          {!!dirtyEntries.length && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
              title={`${dirtyEntries.length} 个文件未保存`}
            />
          )}
          {!!conflicts.length && (
            <span className="min-w-4 shrink-0 rounded-full bg-amber-500 px-1 text-center text-[9px] leading-4 text-white">
              {conflicts.length}
            </span>
          )}
          <ChevronDown
            size={13}
            className={`ml-auto shrink-0 transition ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open &&
          createPortal(
            <div
              ref={popupRef}
              style={popupPosition}
              className="fixed z-[100] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/25 dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                    <GitBranch size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-bold text-slate-800 dark:text-slate-100">
                      {currentBranch ?? "当前分支"}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted">
                      {dirtyEntries.length
                        ? `${dirtyEntries.length} 个文件尚未保存`
                        : syncStatus.data
                          ? `领先 ${syncStatus.data.ahead} · 落后 ${syncStatus.data.behind}`
                          : "个人 Git 工作区"}
                    </div>
                  </div>
                  <button
                    onClick={() => setOpen(false)}
                    className="icon-btn"
                    title="关闭"
                  >
                    <X size={14} />
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2">
                  <ActionButton
                    icon={<Plus size={14} />}
                    label="新建分支"
                    onClick={handleCreateBranch}
                    disabled={readOnly || branchBusy || mergeInProgress}
                  />
                  <ActionButton
                    icon={
                      <RefreshCw
                        size={14}
                        className={syncOps.sync.isPending ? "animate-spin" : ""}
                      />
                    }
                    label="同步"
                    onClick={handleSync}
                    disabled={readOnly || branchBusy || mergeInProgress}
                  />
                  <ActionButton
                    icon={<Upload size={14} />}
                    label="推送"
                    onClick={() => handlePush(false)}
                    disabled={readOnly || push.isPending || mergeInProgress}
                  />
                </div>
              </div>

              {mergeInProgress && (
                <div className="border-b border-amber-200 bg-amber-50 p-3 dark:border-amber-500/20 dark:bg-amber-500/10">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle
                      size={16}
                      className="mt-0.5 shrink-0 text-amber-600"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-amber-800 dark:text-amber-200">
                        {conflicts.length
                          ? `${conflicts.length} 个文件存在冲突`
                          : "冲突均已处理，等待完成合并"}
                      </div>
                      <p className="mt-1 text-[10px] leading-4 text-amber-700 dark:text-amber-300">
                        {conflicts.length
                          ? conflicts.join("、")
                          : "检查结果后创建合并提交。"}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={handleAbortMerge}
                          disabled={readOnly || syncOps.abortMerge.isPending}
                          className="btn btn-ghost btn-sm"
                        >
                          放弃合并
                        </button>
                        <button
                          onClick={() =>
                            conflicts.length
                              ? (setOpen(false), setShowResolver(true))
                              : handleContinueMerge()
                          }
                          disabled={readOnly || syncOps.continueMerge.isPending}
                          className="btn btn-primary btn-sm"
                        >
                          <GitMerge size={13} />
                          {conflicts.length ? "打开三列合并器" : "完成合并"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {(notice || error) && (
                <div
                  className={`border-b px-4 py-2.5 text-[11px] ${
                    error
                      ? "border-red-200 bg-red-50 text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300"
                  }`}
                >
                  {error || notice}
                  {canForce && (
                    <button
                      onClick={async () => {
                        setOpen(false);
                        if (
                          await askConfirm({
                            title: "确认强制推送",
                            message:
                              "远端包含本地没有的提交。继续会用当前项目覆盖远端分支。",
                            confirmText: "强制推送",
                            tone: "danger",
                          })
                        ) {
                          handlePush(true);
                        }
                      }}
                      className="ml-2 font-bold underline"
                    >
                      强制推送
                    </button>
                  )}
                </div>
              )}

              <div className="p-3">
                <div className="relative mb-2">
                  <Search
                    size={13}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="搜索本地分支"
                    className="input h-8 pl-8 text-xs"
                    autoFocus
                  />
                </div>
                <div className="mb-1 px-2 text-[9px] font-bold uppercase tracking-[0.14em] text-muted">
                  Local branches
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {branches.isLoading ? (
                    <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted">
                      <LoaderCircle size={14} className="animate-spin" />
                      正在读取分支…
                    </div>
                  ) : !filteredBranches.length ? (
                    <p className="px-2 py-3 text-xs text-muted">没有匹配分支</p>
                  ) : (
                    filteredBranches.map((branch) => {
                      const active = branch === currentBranch;
                      return (
                        <div
                          key={branch}
                          className="group flex items-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <button
                            onClick={() =>
                              !active &&
                              requestOperation({ kind: "checkout", branch })
                            }
                            disabled={
                              active ||
                              readOnly ||
                              branchBusy ||
                              mergeInProgress
                            }
                            className={`flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-xs ${
                              active
                                ? "font-semibold text-indigo-700 dark:text-indigo-300"
                                : "text-slate-600 dark:text-slate-300"
                            }`}
                            title={active ? "当前分支" : `切换到 ${branch}`}
                          >
                            {active ? (
                              <Check size={14} className="shrink-0" />
                            ) : (
                              <GitBranch
                                size={13}
                                className="shrink-0 text-slate-400"
                              />
                            )}
                            <span className="truncate">{branch}</span>
                          </button>
                          {!active && !readOnly && !mergeInProgress && (
                            <button
                              onClick={() => handleDeleteBranch(branch)}
                              disabled={branchBusy}
                              className="mr-1 hidden rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 group-hover:block dark:hover:bg-red-500/10"
                              title={`删除 ${branch}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <button
                onClick={() => {
                  setOpen(false);
                  setShowRemote(true);
                }}
                disabled={readOnly}
                className="flex w-full items-center gap-2 border-t border-slate-200 px-4 py-3 text-left text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800/70"
              >
                <Settings size={14} />
                <span className="flex-1">Git 仓库、身份与凭据设置</span>
                <span className="text-[10px] text-muted">
                  {remote.data ? remote.data.host : "未配置"}
                </span>
              </button>
            </div>,
            document.body,
          )}
      </div>

      {pendingOperation && (
        <UnsavedSwitchDialog
          operation={pendingOperation}
          dirtyFiles={dirtyEntries.map(([path]) => path)}
          busy={operationBusy}
          error={error}
          onCancel={() => !operationBusy && setPendingOperation(undefined)}
          onSave={() => executeOperation(pendingOperation, "save")}
          onDiscard={() => executeOperation(pendingOperation, "discard")}
        />
      )}
      {showRemote && (
        <GitRemoteModal
          sessionId={sessionId}
          onClose={() => setShowRemote(false)}
        />
      )}
      {showResolver && mergeInProgress && (
        <ConflictResolverModal
          sessionId={sessionId}
          conflicts={conflicts}
          onClose={() => setShowResolver(false)}
        />
      )}
    </>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-[11px] font-semibold text-slate-600 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300 dark:hover:border-indigo-500/30 dark:hover:bg-indigo-500/10"
    >
      {icon} {label}
    </button>
  );
}

function UnsavedSwitchDialog({
  operation,
  dirtyFiles,
  busy,
  error,
  onCancel,
  onSave,
  onDiscard,
}: {
  operation: PendingOperation;
  dirtyFiles: string[];
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const target =
    operation.kind === "checkout"
      ? `切换到 ${operation.branch}`
      : operation.kind === "create"
        ? `创建并切换到 ${operation.branch}`
        : "同步远端代码";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="card w-full max-w-lg p-0 shadow-2xl">
        <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold">切换前处理未保存内容</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              {dirtyFiles.length} 个文件尚未保存。选择如何处理后再{target}。
            </p>
          </div>
          <button
            onClick={onCancel}
            disabled={busy}
            className="icon-btn"
            title="取消"
          >
            <X size={15} />
          </button>
        </div>
        <div className="max-h-40 overflow-y-auto bg-slate-50/70 px-5 py-3 dark:bg-slate-950/30">
          {dirtyFiles.map((path) => (
            <div
              key={path}
              className="flex items-center gap-2 py-1 font-mono text-[11px] text-slate-600 dark:text-slate-300"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              {path}
            </div>
          ))}
        </div>
        {error && (
          <div className="border-t border-red-200 bg-red-50 px-5 py-2.5 text-xs text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
          <button onClick={onCancel} disabled={busy} className="btn btn-ghost">
            取消
          </button>
          <button
            onClick={onDiscard}
            disabled={busy}
            className="btn border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
          >
            放弃并继续
          </button>
          <button onClick={onSave} disabled={busy} className="btn btn-primary">
            {busy ? <LoaderCircle size={14} className="animate-spin" /> : null}
            保存并继续
          </button>
        </div>
      </div>
    </div>
  );
}
