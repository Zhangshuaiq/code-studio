import { useEffect, useRef, useState } from "react";
import Editor, { DiffEditor, OnMount } from "@monaco-editor/react";
import { monacoLang, setupIntelliSense, syncWorkspaceModels, workspaceModelUri, workspacePathFromUri } from "../../lib/monaco";
import { canFormat, fileExt, formatCode } from "../../lib/format";
import { useFileContent, useSaveFile, useWorkspaceSourceIndex } from "../../hooks/useSessionFiles";
import { useTheme } from "../../store/theme";
import { useEditorTabs } from "../../store/editorTabs";
import type { FileChange } from "../../hooks/useSessionChanges";

export function CodeEditor({
  sessionId,
  path,
  change,
  readOnly = false,
}: {
  sessionId?: string;
  path?: string;
  change?: FileChange;
  readOnly?: boolean;
}) {
  const { data, isLoading, isError } = useFileContent(sessionId, path);
  const save = useSaveFile(sessionId);
  const sourceIndex = useWorkspaceSourceIndex(sessionId);
  const theme = useTheme((s) => s.theme);

  const draftState = useEditorTabs((state) =>
    path ? state.drafts[path] : undefined,
  );
  const syncDraft = useEditorTabs((state) => state.syncDraft);
  const setDraftContent = useEditorTabs((state) => state.setDraftContent);
  const markDraftSaved = useEditorTabs((state) => state.markDraftSaved);
  const navigation = useEditorTabs((state) => state.navigation);
  const clearNavigation = useEditorTabs((state) => state.clearNavigation);
  const draft = draftState?.content ?? data?.content ?? "";
  const baseline = draftState?.baseline ?? data?.content ?? "";
  const [formatting, setFormatting] = useState(false);
  const [formatErr, setFormatErr] = useState("");
  const [autoFormat, setAutoFormat] = useState(
    () => localStorage.getItem("autoFormat") !== "false", // 默认开
  );
  const [mode, setMode] = useState<"edit" | "diff">("edit");
  // 用 ref 让快捷键/异步回调/effect 拿到最新值
  const loadedPath = useRef<string | undefined>(undefined);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const pathRef = useRef(path);
  pathRef.current = path;
  const autoFormatRef = useRef(autoFormat);
  autoFormatRef.current = autoFormat;
  const monacoRef = useRef<any>(null);
  const editorRef = useRef<any>(null);

  useEffect(() => {
    if (!monacoRef.current || !sessionId || !sourceIndex.data) return;
    const drafts = useEditorTabs.getState().drafts;
    syncWorkspaceModels(monacoRef.current, sessionId, sourceIndex.data.files.map((file) => ({
      ...file,
      content: drafts[file.path]?.content ?? file.content,
    })));
  }, [sessionId, sourceIndex.data]);

  useEffect(() => {
    if (!editorRef.current || !path || navigation?.path !== path) return;
    const position = { lineNumber: navigation.line, column: navigation.column };
    editorRef.current.setPosition(position);
    editorRef.current.revealPositionInCenter(position);
    editorRef.current.focus();
    clearNavigation();
  }, [path, navigation, clearNavigation]);

  function toggleAutoFormat() {
    const v = !autoFormat;
    setAutoFormat(v);
    localStorage.setItem("autoFormat", String(v));
  }

  // 载入/同步磁盘内容：
  //  - 切到新文件 → 载入
  //  - 同一文件被外部(AI 生成/迭代)改动、且用户没有未保存编辑 → 同步为最新内容
  // 开启自动格式化时，格式化并静默写回（让文件保持格式化、不留"未保存"）
  useEffect(() => {
    if (!data) return;
    const stored = useEditorTabs.getState().drafts[data.path];
    const isNewFile = loadedPath.current !== data.path;
    const diskChanged = data.content !== stored?.baseline;
    const userDirty = !!stored && stored.content !== stored.baseline;
    if (!isNewFile && !(diskChanged && !userDirty)) return;

    loadedPath.current = data.path;
    setFormatErr("");
    const p = data.path;
    // 切回一个仍有未保存草稿的文件时，直接恢复草稿，不用磁盘内容覆盖。
    if (userDirty) return;
    if (!readOnly && autoFormatRef.current && canFormat(p)) {
      formatCode(data.content, p)
        .then((f) => {
          syncDraft(p, f);
          if (f !== data.content) {
            save.mutate({ path: p, content: f });
          }
        })
        .catch(() => {
          syncDraft(p, data.content);
        });
    } else {
      syncDraft(p, data.content);
    }
  }, [data, save, readOnly, syncDraft]);

  const dirty = draft !== baseline;

  // 切换文件时始终默认「编辑」视图；想看本次改动再手动切到「改动」
  const modePathRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (modePathRef.current !== path) {
      modePathRef.current = path;
      setMode("edit");
    }
  }, [path]);

  function doSave() {
    if (readOnly) return;
    const p = pathRef.current;
    const stored = p ? useEditorTabs.getState().drafts[p] : undefined;
    if (p && stored && stored.content !== stored.baseline) {
      const content = stored.content;
      save.mutate({ path: p, content });
      markDraftSaved(p, content);
    }
  }

  async function doFormat() {
    if (readOnly) return;
    const p = pathRef.current;
    if (!p || !canFormat(p)) return;
    setFormatting(true);
    setFormatErr("");
    try {
      const formatted = await formatCode(draftRef.current, p);
      setDraftContent(p, formatted);
    } catch (e) {
      setFormatErr(errText(e));
    } finally {
      setFormatting(false);
    }
  }

  const { openFile } = useEditorTabs();

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    setupIntelliSense(monaco); // 配置 TS/JS 智能补全
    if (sessionId && sourceIndex.data) {
      const drafts = useEditorTabs.getState().drafts;
      syncWorkspaceModels(monaco, sessionId, sourceIndex.data.files.map((file) => ({ ...file, content: drafts[file.path]?.content ?? file.content })));
    }
    const pendingNavigation = useEditorTabs.getState().navigation;
    if (path && pendingNavigation?.path === path) {
      const position = {
        lineNumber: pendingNavigation.line,
        column: pendingNavigation.column,
      };
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      editor.focus();
      clearNavigation();
    }
    // Monaco 内置的 F12 / Ctrl(Cmd)+点击可能直接切换 editor model；同步应用标签状态，
    // 避免画面已经跳到目标文件但保存仍使用旧文件路径。
    editor.onDidChangeModel(() => {
      const targetPath = workspacePathFromUri(editor.getModel()?.uri);
      if (targetPath && targetPath !== pathRef.current) openFile(targetPath);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, doSave);
    // Shift+Alt+F 格式化（与 VS Code 一致）
    editor.addCommand(
      monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
      doFormat,
    );

    // 启用定义跳转功能
    // Ctrl/Cmd + Click 或 F12 跳转到定义
    editor.addAction({
      id: "open-definition-in-tab",
      label: "在新标签页中打开定义",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12],
      contextMenuGroupId: "navigation",
      run: async (ed) => {
        const position = ed.getPosition();
        if (!position) return;

        const model = ed.getModel();
        if (!model) return;

        // 获取定义位置
        const definitions = await monaco.languages.getDefinitionAtPosition(
          model,
          position,
        );

        if (definitions && definitions.length > 0) {
          const def = definitions[0];
          const targetPath = workspacePathFromUri(def.uri) ?? def.uri.path;
          const currentPath = workspacePathFromUri(model.uri) ?? model.uri.path;

          // 如果定义在另一个文件中，打开该文件
          if (targetPath !== currentPath) {
            // 移除路径前缀（如果有的话）
            const cleanPath = targetPath.startsWith("/")
              ? targetPath.substring(1)
              : targetPath;
            openFile(cleanPath, def.range.startLineNumber, def.range.startColumn);
          } else {
            // 在当前文件中跳转
            ed.setPosition({
              lineNumber: def.range.startLineNumber,
              column: def.range.startColumn,
            });
            ed.revealPositionInCenter({
              lineNumber: def.range.startLineNumber,
              column: def.range.startColumn,
            });
          }
        }
      },
    });

    // 添加查找所有引用的命令
    editor.addAction({
      id: "find-all-references",
      label: "查找所有引用",
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      contextMenuGroupId: "navigation",
      run: async (ed) => {
        // Monaco 内置的查找引用功能
        ed.getAction("editor.action.goToReferences")?.run();
      },
    });
  };

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50/70 text-sm dark:bg-slate-950/30">
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-8 py-6 text-center text-muted shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
          <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" />
          从左侧选择文件查看或编辑
        </div>
      </div>
    );
  }

  const ext = fileExt(path) || "txt";
  const formattable = canFormat(path);

  return (
    <div className="flex h-full flex-col bg-white dark:bg-slate-900">
      {/* 顶部工具条 */}
      <div className="panel flex min-h-[46px] items-center gap-3 border-b px-4">
        <span className="grid h-6 min-w-[2rem] place-items-center rounded-lg bg-indigo-50 px-1.5 font-mono text-[9px] font-bold uppercase text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
          {ext}
        </span>
        <span className="truncate text-xs font-medium text-slate-600 dark:text-slate-300">
          {path}
        </span>
        {dirty && (
          <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
            ● 未保存
          </span>
        )}
        {change && (
          <span
            className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${
              change.kind === "added"
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400"
                : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"
            }`}
          >
            {change.kind === "added" ? "本次新增" : "本次改动"}
          </span>
        )}
        {change && (
          <div className="flex overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-[10px] dark:border-slate-700 dark:bg-slate-950/50">
            <button
              onClick={() => setMode("edit")}
              className={`rounded-md px-2 py-0.5 ${mode === "edit" ? "bg-white font-semibold text-indigo-600 shadow-sm dark:bg-slate-800 dark:text-indigo-300" : "text-muted"}`}
            >
              编辑
            </button>
            <button
              onClick={() => setMode("diff")}
              className={`rounded-md px-2 py-0.5 ${mode === "diff" ? "bg-white font-semibold text-indigo-600 shadow-sm dark:bg-slate-800 dark:text-indigo-300" : "text-muted"}`}
            >
              改动
            </button>
          </div>
        )}
        {formatErr && (
          <span className="truncate text-[10px] text-red-500" title={formatErr}>
            格式化失败
          </span>
        )}
        {sourceIndex.data?.truncated && (
          <span
            className="truncate text-[10px] text-amber-600 dark:text-amber-400"
            title="源码模型达到浏览器索引上限，部分跨文件跳转可能不可用"
          >
            部分源码未索引
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {save.isSuccess && !dirty && (
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
              已保存 · 预览将热更新
            </span>
          )}
          <label
            className="flex cursor-pointer select-none items-center gap-1 text-[11px] text-muted"
            title="打开文件时自动格式化并保存"
          >
            <input
              type="checkbox"
              checked={autoFormat}
              onChange={toggleAutoFormat}
              className="accent-indigo-600"
            />
            自动格式化
          </label>
          <button
            onClick={doFormat}
            disabled={readOnly || !formattable || formatting}
            className="btn btn-ghost btn-sm"
            title="格式化 (Shift+Alt+F)"
          >
            {formatting ? "格式化…" : "格式化"}
          </button>
          <button
            onClick={doSave}
            disabled={readOnly || !dirty || save.isPending}
            className="btn btn-primary btn-sm"
            title="保存 (⌘/Ctrl+S)"
          >
            {save.isPending ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      {/* Monaco 编辑区 / 改动对比 */}
      <div className="min-h-0 flex-1">
        {isLoading ? (
          <Center>加载中…</Center>
        ) : isError ? (
          <Center>无法读取该文件（可能过大或为二进制）</Center>
        ) : mode === "diff" && change ? (
          <DiffEditor
            key={"diff-" + path}
            language={monacoLang(path)}
            original={change.before}
            modified={draft}
            theme={theme === "dark" ? "vs-dark" : "light"}
            options={{
              fontSize: 13,
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        ) : (
          <Editor
            key={path}
            path={sessionId ? workspaceModelUri(sessionId, path) : path}
            language={monacoLang(path)}
            value={draft}
            onChange={(v) => setDraftContent(path, v ?? "")}
            onMount={handleMount}
            theme={theme === "dark" ? "vs-dark" : "light"}
            options={{
              fontSize: 13,
              readOnly,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 12 },
              smoothScrolling: true,
              renderWhitespace: "selection",
              // 更聪明的提示
              quickSuggestions: { other: true, comments: false, strings: true },
              suggestOnTriggerCharacters: true,
              tabCompletion: "on",
              wordBasedSuggestions: "allDocuments",
              suggestSelection: "first",
              parameterHints: { enabled: true },
              formatOnPaste: true,
              bracketPairColorization: { enabled: true },
            }}
          />
        )}
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted">
      {children}
    </div>
  );
}

function errText(err: unknown): string {
  const e = err as { message?: string };
  return e?.message ?? "未知错误";
}
