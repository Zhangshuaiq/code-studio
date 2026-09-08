import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  FileWarning,
  GitMerge,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  useConflictDetail,
  useRemoteSyncOps,
  useResolveConflict,
  type ConflictDetail,
  type ConflictHunk,
  type ConflictResolution,
} from "../../hooks/useGit";
import { monacoLang } from "../../lib/monaco";
import { useTheme } from "../../store/theme";
import { useFeedback } from "../common/FeedbackProvider";

type HunkChoice = "ours" | "theirs" | "both";
type ResultEditor = Parameters<OnMount>[0];
type MonacoApi = Parameters<OnMount>[1];

export function ConflictResolverModal({
  sessionId,
  conflicts,
  onClose,
}: {
  sessionId?: string;
  conflicts: string[];
  onClose: () => void;
}) {
  const theme = useTheme((state) => state.theme);
  const { confirm, toast } = useFeedback();
  const [selected, setSelected] = useState<string | undefined>(conflicts[0]);
  const [draft, setDraft] = useState("");
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState("");
  const [activeHunk, setActiveHunk] = useState(0);
  const [hunkChoices, setHunkChoices] = useState<Record<number, HunkChoice>>(
    {},
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const resultEditorRef = useRef<ResultEditor | null>(null);
  const oursEditorRef = useRef<ResultEditor | null>(null);
  const theirsEditorRef = useRef<ResultEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const oursDecorationIdsRef = useRef<string[]>([]);
  const theirsDecorationIdsRef = useRef<string[]>([]);
  const syncingScrollRef = useRef(false);

  const detail = useConflictDetail(sessionId, selected);
  const resolve = useResolveConflict(sessionId);
  const syncOps = useRemoteSyncOps(sessionId);

  useEffect(() => {
    if (!selected || !conflicts.includes(selected)) setSelected(conflicts[0]);
  }, [conflicts, selected]);

  useEffect(() => {
    if (!detail.data) return;
    const initial =
      detail.data.suggestions.ours ??
      detail.data.suggestions.theirs ??
      detail.data.result.content ??
      "";
    setDraft(initial);
    setBaseline(initial);
    setError("");
    setActiveHunk(0);
    setHunkChoices({});
  }, [detail.data]);

  const dirty = draft !== baseline;

  async function apply(resolution: ConflictResolution, content?: string) {
    if (!selected) return;
    setError("");
    try {
      const result = await resolve.mutateAsync({
        path: selected,
        resolution,
        content,
      });
      toast(
        result.remaining.length
          ? `已解决 ${selected}，还剩 ${result.remaining.length} 个文件`
          : "所有冲突文件均已解决，可以完成合并。",
        { title: "冲突已解决", tone: "success" },
      );
      setSelected(result.remaining[0]);
    } catch (requestError: any) {
      setError(requestError?.response?.data?.message ?? String(requestError));
    }
  }

  async function chooseVersion(side: "ours" | "theirs") {
    const value = detail.data?.suggestions[side];
    if (typeof value === "string") {
      if (detail.data?.hunks.length) applyAllHunks(side);
      else setDraft(value);
      return;
    }
    const sideName = side === "ours" ? "当前版本" : "远端版本";
    if (
      await confirm({
        title: `${sideName}已删除此文件`,
        message: `选择${sideName}会删除 ${selected}，是否继续？`,
        confirmText: "确认删除",
        tone: "danger",
      })
    ) {
      await apply(side);
    }
  }

  function applyAllHunks(choice: HunkChoice) {
    const hunks = detail.data?.hunks ?? [];
    // 从后向前替换，手工编辑过的前方区间也不会因后方长度变化而漂移。
    for (let index = hunks.length - 1; index >= 0; index -= 1) {
      applyHunk(index, choice, false);
    }
    focusHunk(activeHunk);
  }

  function applyHunk(index: number, choice: HunkChoice, focusNext = true) {
    const editor = resultEditorRef.current;
    const monaco = monacoRef.current;
    const hunk = detail.data?.hunks[index];
    const decorationId = decorationIdsRef.current[index];
    const model = editor?.getModel();
    const range = decorationId ? model?.getDecorationRange(decorationId) : null;
    if (!editor || !monaco || !model || !hunk || !range) return;

    const replacement = hunkText(hunk, choice);
    const startOffset = model.getOffsetAt(range.getStartPosition());
    editor.executeEdits("merge-conflict-arrow", [
      { range, text: replacement, forceMoveMarkers: true },
    ]);

    const trackedRanges = decorationIdsRef.current.map((id, hunkIndex) => {
      if (hunkIndex === index) {
        const start = model.getPositionAt(startOffset);
        const end = model.getPositionAt(startOffset + replacement.length);
        return new monaco.Range(
          start.lineNumber,
          start.column,
          end.lineNumber,
          end.column,
        );
      }
      return model.getDecorationRange(id) ?? new monaco.Range(1, 1, 1, 1);
    });
    decorationIdsRef.current = editor.deltaDecorations(
      decorationIdsRef.current,
      trackedRanges.map((trackedRange, hunkIndex) => ({
        range: trackedRange,
        options: hunkDecorationOptions(monaco, hunkIndex === index),
      })),
    );
    setDraft(model.getValue());
    setHunkChoices((current) => ({ ...current, [index]: choice }));
    if (focusNext) {
      focusHunk(
        index < (detail.data?.hunks.length ?? 0) - 1 ? index + 1 : index,
      );
    }
  }

  function focusHunk(index: number) {
    const editor = resultEditorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model || !detail.data?.hunks.length) return;
    const next = Math.max(0, Math.min(index, detail.data.hunks.length - 1));
    const ranges = decorationIdsRef.current.map(
      (id) => model.getDecorationRange(id) ?? new monaco.Range(1, 1, 1, 1),
    );
    decorationIdsRef.current = editor.deltaDecorations(
      decorationIdsRef.current,
      ranges.map((range, hunkIndex) => ({
        range,
        options: hunkDecorationOptions(monaco, hunkIndex === next),
      })),
    );
    const range = ranges[next];
    editor.setPosition(range.getStartPosition());
    editor.revealRangeInCenter(range);
    editor.focus();
    setActiveHunk(next);
  }

  async function selectPath(path: string) {
    if (
      dirty &&
      !(await confirm({
        title: "放弃未保存的合并结果？",
        message: "切换文件会丢弃当前结果区尚未保存的修改。",
        confirmText: "继续切换",
        tone: "danger",
      }))
    ) {
      return;
    }
    setSelected(path);
  }

  async function requestClose() {
    if (
      dirty &&
      !(await confirm({
        title: "关闭合并器？",
        message: "当前结果区有未保存的修改；关闭后这些修改不会保留。",
        confirmText: "仍然关闭",
        tone: "danger",
      }))
    ) {
      return;
    }
    onClose();
  }

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void requestClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  async function removeFile() {
    if (
      selected &&
      (await confirm({
        title: "删除冲突文件",
        message: `确认把 ${selected} 作为删除结果吗？`,
        confirmText: "删除文件",
        tone: "danger",
      }))
    ) {
      await apply("delete");
    }
  }

  async function finishMerge() {
    setError("");
    try {
      await syncOps.continueMerge.mutateAsync();
      toast("合并提交已经创建。", { title: "合并完成", tone: "success" });
      onClose();
    } catch (requestError: any) {
      setError(requestError?.response?.data?.message ?? String(requestError));
    }
  }

  async function abortMerge() {
    if (
      await confirm({
        title: "放弃本次合并",
        message: "本次同步产生的合并结果和冲突处理都会被撤销。",
        confirmText: "放弃合并",
        tone: "danger",
      })
    ) {
      await syncOps.abortMerge.mutateAsync();
      onClose();
    }
  }

  const saveMount: OnMount = (editor, monaco) => {
    resultEditorRef.current = editor;
    monacoRef.current = monaco;
    const model = editor.getModel();
    const hunks = detail.data?.hunks ?? [];
    decorationIdsRef.current = model
      ? editor.deltaDecorations(
          [],
          hunks.map((hunk, index) => {
            const start = model.getPositionAt(hunk.resultStart);
            const end = model.getPositionAt(hunk.resultEnd);
            return {
              range: new monaco.Range(
                start.lineNumber,
                start.column,
                end.lineNumber,
                end.column,
              ),
              options: hunkDecorationOptions(monaco, index === 0),
            };
          }),
        )
      : [];
    editor.onMouseDown((event) => {
      if (
        event.target.type !==
          monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        !event.target.position
      ) {
        return;
      }
      const index = decorationIdsRef.current.findIndex((id) => {
        const range = editor.getModel()?.getDecorationRange(id);
        return (
          !!range &&
          event.target.position!.lineNumber >= range.startLineNumber &&
          event.target.position!.lineNumber <= range.endLineNumber
        );
      });
      if (index >= 0) focusHunk(index);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (selected) void apply("manual", draftRef.current);
    });
    attachScrollSync(editor);
  };

  function sourceMount(side: "ours" | "theirs"): OnMount {
    return (editor, monaco) => {
      if (side === "ours") oursEditorRef.current = editor;
      else theirsEditorRef.current = editor;
      monacoRef.current = monaco;
      const model = editor.getModel();
      const hunks = detail.data?.hunks ?? [];
      const ids = model
        ? editor.deltaDecorations(
            [],
            hunks.map((hunk) => {
              const startOffset =
                side === "ours" ? hunk.oursStart : hunk.theirsStart;
              const endOffset = side === "ours" ? hunk.oursEnd : hunk.theirsEnd;
              const start = model.getPositionAt(startOffset);
              const end = model.getPositionAt(endOffset);
              return {
                range: new monaco.Range(
                  start.lineNumber,
                  start.column,
                  end.lineNumber,
                  end.column,
                ),
                options: sourceHunkDecorationOptions(side),
              };
            }),
          )
        : [];
      if (side === "ours") oursDecorationIdsRef.current = ids;
      else theirsDecorationIdsRef.current = ids;

      editor.onMouseDown((event) => {
        if (
          event.target.type !==
            monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
          !event.target.position
        ) {
          return;
        }
        const sourceIds =
          side === "ours"
            ? oursDecorationIdsRef.current
            : theirsDecorationIdsRef.current;
        const index = sourceIds.findIndex((id) => {
          const range = editor.getModel()?.getDecorationRange(id);
          return (
            !!range &&
            event.target.position!.lineNumber >= range.startLineNumber &&
            event.target.position!.lineNumber <= range.endLineNumber
          );
        });
        if (index >= 0) applyHunk(index, side);
      });
      attachScrollSync(editor);
    };
  }

  function attachScrollSync(source: ResultEditor) {
    source.onDidScrollChange((event) => {
      if (!event.scrollTopChanged || syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      for (const editor of [
        oursEditorRef.current,
        resultEditorRef.current,
        theirsEditorRef.current,
      ]) {
        if (editor && editor !== source) editor.setScrollTop(event.scrollTop);
      }
      requestAnimationFrame(() => {
        syncingScrollRef.current = false;
      });
    });
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/65 p-2 backdrop-blur-sm sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="可视化解决 Git 合并冲突"
    >
      <div className="flex h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <header className="flex min-h-[62px] items-center gap-4 border-b border-slate-200 px-5 dark:border-slate-800">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <GitMerge size={19} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">
              可视化解决合并冲突
            </h2>
            <p className="mt-0.5 text-[11px] text-muted">
              当前版本与远端版本分列两侧，通过行箭头合并到中间结果
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={abortMerge}
              disabled={syncOps.abortMerge.isPending}
              className="btn btn-ghost btn-sm inline-flex items-center gap-1.5"
            >
              <RotateCcw size={14} /> 放弃合并
            </button>
            <button onClick={requestClose} className="icon-btn" title="关闭">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-950/30">
            <div className="sticky top-0 border-b border-slate-200 bg-slate-50/95 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.12em] text-muted backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
              未解决文件 ({conflicts.length})
            </div>
            {conflicts.length ? (
              <ul className="p-2">
                {conflicts.map((path) => (
                  <li key={path}>
                    <button
                      onClick={() => selectPath(path)}
                      className={`mb-1 flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left text-[11px] transition ${
                        path === selected
                          ? "bg-amber-100 font-semibold text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"
                          : "text-slate-600 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800"
                      }`}
                      title={path}
                    >
                      <FileWarning size={14} className="mt-0.5 shrink-0" />
                      <span className="break-all leading-4">{path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-4 py-8 text-center">
                <CheckCircle2 size={30} className="mx-auto text-emerald-500" />
                <p className="mt-3 text-xs font-semibold">文件冲突已全部解决</p>
              </div>
            )}
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            {error && (
              <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                {error}
              </div>
            )}

            {!conflicts.length ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
                <CheckCircle2 size={48} className="text-emerald-500" />
                <div>
                  <h3 className="text-base font-bold">所有文件都已处理</h3>
                  <p className="mt-1 text-xs text-muted">
                    现在可以创建合并提交。
                  </p>
                </div>
                <button
                  onClick={finishMerge}
                  disabled={syncOps.continueMerge.isPending}
                  className="btn btn-primary inline-flex items-center gap-2"
                >
                  <GitMerge size={16} />
                  {syncOps.continueMerge.isPending ? "提交中…" : "完成合并"}
                </button>
              </div>
            ) : detail.isLoading ? (
              <Center>正在读取 Git 三方版本…</Center>
            ) : detail.isError || !detail.data || !selected ? (
              <Center>无法读取该冲突文件，请刷新状态后重试。</Center>
            ) : detail.data.fileType === "text" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex min-h-[44px] items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-800">
                  <span
                    className="mr-1 truncate text-xs font-semibold"
                    title={selected}
                  >
                    {selected}
                  </span>
                  <ConflictBadge detail={detail.data} />
                  <span className="ml-auto text-[10px] text-muted">
                    点击左右代码行旁的箭头，将该冲突块移入中间结果列
                  </span>
                </div>

                <div className="grid min-h-0 flex-1 grid-cols-3 bg-slate-100 dark:bg-slate-950">
                  <MergePane
                    title="当前用户版本"
                    tone="ours"
                    action={
                      <button
                        onClick={() => chooseVersion("ours")}
                        className="btn btn-ghost btn-sm inline-flex items-center gap-1"
                        title="全部采用当前用户版本"
                      >
                        全部 <ArrowRight size={13} />
                      </button>
                    }
                  >
                    <Editor
                      key={`${selected}-ours-${detail.data.hunks.length}`}
                      language={monacoLang(selected)}
                      value={detail.data.suggestions.ours ?? ""}
                      onMount={sourceMount("ours")}
                      theme={theme === "dark" ? "vs-dark" : "light"}
                      options={sourceEditorOptions}
                    />
                  </MergePane>

                  <MergePane
                    title="合并结果"
                    tone="result"
                    action={
                      <div className="flex items-center gap-1">
                        {!!detail.data.hunks.length && (
                          <>
                            <button
                              onClick={() => focusHunk(activeHunk - 1)}
                              disabled={activeHunk === 0}
                              className="icon-btn h-7 w-7"
                              title="上一处冲突"
                            >
                              <ArrowUp size={13} />
                            </button>
                            <span className="min-w-9 text-center text-[10px] font-bold text-amber-700 dark:text-amber-300">
                              {activeHunk + 1}/{detail.data.hunks.length}
                            </span>
                            <button
                              onClick={() => focusHunk(activeHunk + 1)}
                              disabled={
                                activeHunk === detail.data.hunks.length - 1
                              }
                              className="icon-btn h-7 w-7"
                              title="下一处冲突"
                            >
                              <ArrowDown size={13} />
                            </button>
                            <button
                              onClick={() => applyHunk(activeHunk, "both")}
                              className={`btn btn-sm ${
                                hunkChoices[activeHunk] === "both"
                                  ? "border border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-300"
                                  : "btn-ghost"
                              }`}
                              title="当前冲突块两边都保留"
                            >
                              两者
                            </button>
                          </>
                        )}
                        <button
                          onClick={removeFile}
                          className="icon-btn h-7 w-7 text-red-600"
                          title="删除文件"
                        >
                          <Trash2 size={13} />
                        </button>
                        <button
                          onClick={() => apply("manual", draft)}
                          disabled={resolve.isPending}
                          className="btn btn-primary btn-sm inline-flex items-center gap-1"
                        >
                          <Save size={13} />
                          {resolve.isPending ? "保存中" : "保存"}
                        </button>
                      </div>
                    }
                    dirty={dirty}
                  >
                    <Editor
                      key={`${selected}-result-${detail.data.hunks.length}`}
                      language={monacoLang(selected)}
                      value={draft}
                      onChange={(value) => setDraft(value ?? "")}
                      onMount={saveMount}
                      theme={theme === "dark" ? "vs-dark" : "light"}
                      options={resultEditorOptions}
                    />
                  </MergePane>

                  <MergePane
                    title="远端版本"
                    tone="theirs"
                    action={
                      <button
                        onClick={() => chooseVersion("theirs")}
                        className="btn btn-ghost btn-sm inline-flex items-center gap-1"
                        title="全部采用远端版本"
                      >
                        <ArrowLeft size={13} /> 全部
                      </button>
                    }
                    last
                  >
                    <Editor
                      key={`${selected}-theirs-${detail.data.hunks.length}`}
                      language={monacoLang(selected)}
                      value={detail.data.suggestions.theirs ?? ""}
                      onMount={sourceMount("theirs")}
                      theme={theme === "dark" ? "vs-dark" : "light"}
                      options={sourceEditorOptions}
                    />
                  </MergePane>
                </div>

                {!!detail.data.hunks.length && (
                  <div className="flex min-h-[30px] items-center border-t border-slate-200 bg-white px-3 text-[10px] text-muted dark:border-slate-800 dark:bg-slate-900">
                    已通过箭头处理 {Object.keys(hunkChoices).length}/
                    {detail.data.hunks.length} 个冲突块；中间结果仍可直接编辑
                  </div>
                )}
              </div>
            ) : (
              <NonTextConflict
                detail={detail.data}
                pending={resolve.isPending}
                onChoose={(resolution) => apply(resolution)}
                onDelete={removeFile}
              />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function NonTextConflict({
  detail,
  pending,
  onChoose,
  onDelete,
}: {
  detail: ConflictDetail;
  pending: boolean;
  onChoose: (resolution: "ours" | "theirs") => void;
  onDelete: () => void;
}) {
  const reason =
    detail.fileType === "binary"
      ? "这是二进制文件，不能进行文本合并。请选择一个完整版本。"
      : "文件超过 512KB，在线编辑已关闭。请选择一个完整版本，避免浏览器占用过多内存。";
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-2xl rounded-2xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-500/20 dark:bg-amber-500/10">
        <AlertTriangle size={30} className="text-amber-600" />
        <h3 className="mt-4 text-base font-bold">无法在线进行文本合并</h3>
        <p className="mt-2 text-xs leading-6 text-amber-800 dark:text-amber-300">
          {reason}
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <VersionCard label="当前用户版本" version={detail.ours} />
          <VersionCard label="远端版本" version={detail.theirs} />
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            onClick={() => onChoose("ours")}
            disabled={pending}
            className="btn btn-primary"
          >
            {detail.ours.exists ? "采用当前版本" : "采用当前版本（删除）"}
          </button>
          <button
            onClick={() => onChoose("theirs")}
            disabled={pending}
            className="btn btn-ghost border border-slate-300 dark:border-slate-700"
          >
            {detail.theirs.exists ? "采用远端版本" : "采用远端版本（删除）"}
          </button>
          <button
            onClick={onDelete}
            disabled={pending}
            className="btn btn-ghost text-red-600"
          >
            删除文件
          </button>
        </div>
      </div>
    </div>
  );
}

function VersionCard({
  label,
  version,
}: {
  label: string;
  version: { exists: boolean; size: number };
}) {
  return (
    <div className="rounded-xl border border-amber-200 bg-white/75 p-4 dark:border-amber-500/20 dark:bg-slate-900/50">
      <div className="text-xs font-bold">{label}</div>
      <div className="mt-1 text-[11px] text-muted">
        {version.exists ? formatBytes(version.size) : "该版本已删除文件"}
      </div>
    </div>
  );
}

function ConflictBadge({ detail }: { detail: ConflictDetail }) {
  const labels: Record<ConflictDetail["conflictType"], string> = {
    content: "内容冲突",
    "both-added": "双方新增",
    "deleted-by-us": "当前已删除",
    "deleted-by-them": "远端已删除",
    other: "结构冲突",
  };
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
      {labels[detail.conflictType]}
    </span>
  );
}

const sourceEditorOptions = {
  automaticLayout: true,
  fontSize: 12,
  readOnly: true,
  domReadOnly: true,
  glyphMargin: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  lineNumbersMinChars: 3,
  renderLineHighlight: "none" as const,
  padding: { top: 8 },
};

const resultEditorOptions = {
  automaticLayout: true,
  fontSize: 12,
  glyphMargin: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  lineNumbersMinChars: 3,
  padding: { top: 8 },
};

function MergePane({
  title,
  tone,
  action,
  dirty = false,
  last = false,
  children,
}: {
  title: string;
  tone: "ours" | "result" | "theirs";
  action: React.ReactNode;
  dirty?: boolean;
  last?: boolean;
  children: React.ReactNode;
}) {
  const toneClass = {
    ours: "bg-blue-500",
    result: "bg-amber-500",
    theirs: "bg-emerald-500",
  }[tone];
  return (
    <section
      className={`flex min-w-0 flex-col bg-white dark:bg-slate-900 ${
        last ? "" : "border-r border-slate-300 dark:border-slate-700"
      }`}
    >
      <div className="flex min-h-[42px] items-center gap-2 border-b border-slate-200 px-2.5 dark:border-slate-800">
        <span className={`h-2 w-2 shrink-0 rounded-full ${toneClass}`} />
        <span className="truncate text-[11px] font-bold">{title}</span>
        {dirty && <span className="text-[9px] text-amber-600">● 未保存</span>}
        <div className="ml-auto flex items-center">{action}</div>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function hunkText(hunk: ConflictHunk, choice: HunkChoice) {
  if (choice === "ours") return hunk.ours;
  if (choice === "theirs") return hunk.theirs;
  if (!hunk.ours) return hunk.theirs;
  if (!hunk.theirs) return hunk.ours;
  return `${hunk.ours}${hunk.ours.endsWith("\n") ? "" : "\n"}${hunk.theirs}`;
}

function hunkDecorationOptions(monaco: MonacoApi, active: boolean) {
  return {
    className: active
      ? "merge-conflict-hunk merge-conflict-hunk-active"
      : "merge-conflict-hunk",
    glyphMarginClassName: active
      ? "merge-conflict-glyph merge-conflict-glyph-active"
      : "merge-conflict-glyph",
    hoverMessage: {
      value: active ? "当前冲突块：使用上方快捷箭头选择结果" : "未处理的冲突块",
    },
    stickiness:
      monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
  };
}

function sourceHunkDecorationOptions(side: "ours" | "theirs") {
  return {
    className:
      side === "ours" ? "merge-source-hunk-ours" : "merge-source-hunk-theirs",
    glyphMarginClassName:
      side === "ours" ? "merge-accept-ours-glyph" : "merge-accept-theirs-glyph",
    hoverMessage: {
      value:
        side === "ours"
          ? "点击 → 将当前版本的这一块移入合并结果"
          : "点击 ← 将远端版本的这一块移入合并结果",
    },
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted">
      {children}
    </div>
  );
}
