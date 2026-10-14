import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { DiffEditor, OnMount, useMonaco } from "@monaco-editor/react";
import { WorkspaceFileViewer } from './WorkspaceFileViewer';
import type { MarkdownNavigation } from '../../lib/markdown-resource';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { editorLocation, type EditorLocation } from '../../lib/editor-navigation';
import { installWorkspaceLanguageProviders, monacoLang, setupIntelliSense, syncWorkspaceModels, workspaceModelUri, workspacePathFromUri } from "../../lib/monaco";
import { requestWorkspaceLanguage, supportsWorkspaceLanguage, workspaceLanguageError } from '../../lib/workspace-language';
import { canFormat, fileExt, formatCode } from "../../lib/format";
import { fetchWorkspaceFile, useFileContent, useSaveFile, useWorkspaceSourceIndex } from "../../hooks/useSessionFiles";
import { useTheme } from "../../store/theme";
import { useEditorTabs } from "../../store/editorTabs";
import type { FileChange } from "../../hooks/useSessionChanges";
import { useEditorPreferences } from '../../store/editorPreferences';
import { useEditorAppearance } from '../../hooks/useEditorAppearance';
import { navigationDirection, navigationShortcuts } from '../../lib/editor-keymap';
import { Select } from '../common/Select';
import { api } from '../../lib/api';
import { useGitBlame } from '../../hooks/useGitBlame';
import { GitBlameDetails } from './GitBlameDetails';
import { RemoteFilePreview } from './RemoteFilePreview';
import { DesktopLanguageStatus } from '../Desktop/DesktopLanguageStatus';
import { WorkspaceSqlBinding } from './WorkspaceSqlBinding';
import { workspaceSqlScope, readWorkspaceSqlContext } from '../../lib/workspace-sql-context';
import { useMe } from '../../hooks/useMe';
import { useAuth } from '../../store/auth';
let sqlAuthScopeSerial = 0;

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
  readOnly = readOnly || !!path?.startsWith('@java-source/');
  const me = useMe();
  const authToken = useAuth(state => state.token);
  const authScope = useRef<{ token: string | null; id: number }>();
  if (!authScope.current || authScope.current.token !== authToken) authScope.current = { token: authToken, id: ++sqlAuthScopeSerial };
  const sqlScope = sessionId && me.data?.id ? JSON.stringify([workspaceSqlScope('remote', sessionId, me.data.id), authScope.current.id]) : undefined;
  const sqlScopeRef = useRef(sqlScope); sqlScopeRef.current = sqlScope;
  const monaco = useMonaco();
  const { navigationKeymap, setNavigationKeymap } = useEditorPreferences();
  const shortcuts = navigationShortcuts(navigationKeymap, navigator.platform);
  const queryClient = useQueryClient();
  const [languageError, setLanguageError] = useState('');
  const [languageFallback, setLanguageFallback] = useState(false);
  const [markdownTarget, setMarkdownTarget] = useState<MarkdownNavigation>();
  useEffect(() => setMarkdownTarget(undefined), [sessionId]);
  const markdownAnchorApplied = useCallback(() => setMarkdownTarget(undefined), []);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const navigationRequest = useRef(0);
  const { data, isLoading, isError } = useFileContent(sessionId, path);
  const nonText = !!data?.kind && data.kind !== 'text';
  const loadMarkdownImage = useCallback(async (resource: string, signal: AbortSignal) => {
    const response = await api.get(`/sessions/${sessionId}/files/preview`, { params: { path: resource }, responseType: 'blob', signal, timeout: 30000 });
    return new Blob([response.data], { type: response.headers['content-type'] || response.data.type });
  }, [sessionId]);
  readOnly = readOnly || !!data?.readOnly || nonText;
  const save = useSaveFile(sessionId);
  const sourceIndex = useWorkspaceSourceIndex(sessionId, languageFallback);
  const theme = useTheme((s) => s.theme);
  const { editorTheme, appearanceOptions, baseAppearanceOptions } = useEditorAppearance(monaco, theme);

  const draftState = useEditorTabs((state) =>
    path ? state.drafts[path] : undefined,
  );
  const syncDraft = useEditorTabs((state) => state.syncDraft);
  const setDraftContent = useEditorTabs((state) => state.setDraftContent);
  const markDraftSaved = useEditorTabs((state) => state.markDraftSaved);
  const navigation = useEditorTabs((state) => state.navigation);
  const clearNavigation = useEditorTabs((state) => state.clearNavigation);
  const history = useEditorTabs((state) => state.navigationHistory);
  const historyIndex = useEditorTabs((state) => state.navigationHistoryIndex);
  const draft = draftState?.content ?? data?.content ?? "";
  const baseline = draftState?.baseline ?? data?.content ?? "";
  const nativeBlameUnsupported = data?.encoding?.startsWith('utf-16');
  const blame = useGitBlame(sessionId, nonText || nativeBlameUnsupported ? undefined : path, draft, async (file, content, signal) => (await api.post(`/sessions/${sessionId}/git/blame`, { path: file, content }, { signal })).data, appearanceOptions.lineNumbers === 'on');
  const [formatting, setFormatting] = useState(false);
  const [formatErr, setFormatErr] = useState("");
  const [saveErr, setSaveErr] = useState("");
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
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const autoFormatRef = useRef(autoFormat);
  autoFormatRef.current = autoFormat;
  const monacoRef = useRef<any>(null);
  const editorRef = useRef<any>(null);
  const savingRef = useRef(false);
  const historyTravelRef = useRef<(direction: -1 | 1) => Promise<void>>(async () => {});
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const direction = navigationDirection(navigationKeymap, navigator.platform, event);
      if (!direction || !editorRef.current?.getDomNode()?.contains(document.activeElement)) return;
      event.preventDefault(); event.stopPropagation();
      void historyTravelRef.current(direction as -1 | 1);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [navigationKeymap]);

  const currentLocation = (editor = editorRef.current): EditorLocation | undefined => {
    const model = editor?.getModel();
    const file = model?.uri.authority === sessionRef.current ? workspacePathFromUri(model.uri) : null;
    const position = editor?.getPosition();
    return file && position ? editorLocation(file, position.lineNumber, position.column) : undefined;
  };

  historyTravelRef.current = async (direction) => {
    const state = useEditorTabs.getState();
    const index = state.navigationHistoryIndex + direction;
    const target = state.navigationHistory[index];
    const currentSession = sessionRef.current;
    const origin = currentLocation();
    if (!target || !currentSession || !origin) return;
    const requestId = ++navigationRequest.current;
    try {
      await queryClient.fetchQuery({ queryKey: ['file', currentSession, target.path], queryFn: () => fetchWorkspaceFile(currentSession, target.path), staleTime: Infinity });
      const latest = useEditorTabs.getState();
      if (requestId !== navigationRequest.current || sessionRef.current !== currentSession || pathRef.current !== origin.path || latest.navigationHistory !== state.navigationHistory || latest.navigationHistoryIndex !== state.navigationHistoryIndex) return;
      latest.restoreHistory(index, origin);
    } catch (error) { if (requestId === navigationRequest.current) setLanguageError(workspaceLanguageError(error)); }
  };

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    setLanguageError('');
    setLanguageFallback(false);
    void requestWorkspaceLanguage(sessionId, 'prepare').then((result) => {
      if (active && result.providers?.some((provider: any) => !provider.ready)) setLanguageError('部分语言服务未就绪，请检查服务器语言组件配置');
    }).catch((error) => { if (active) { setLanguageError(workspaceLanguageError(error)); setLanguageFallback(true); } });
    return () => { active = false; navigationRequest.current++; };
  }, [sessionId]);

  useEffect(() => {
    if (!monaco || !sessionId) return;
    let active = true;
    const providers = installWorkspaceLanguageProviders(monaco, sessionId, (operation, input) => requestWorkspaceLanguage(sessionId, operation, input), {
      sqlContext: () => sqlScopeRef.current ? readWorkspaceSqlContext(sqlScopeRef.current) : undefined,
      onError: (error) => setLanguageError(workspaceLanguageError(error)),
      prepareEdits: async (edit) => {
        const paths = [...new Set<string>(edit.edits.map((file: any) => file.path))];
        if (paths.length > 100 || paths.some((path) => path.startsWith('@java-source/'))) throw new Error('重命名超出可编辑范围，未应用修改');
        let bytes = 0;
        for (const path of paths) {
          const file = await fetchWorkspaceFile(sessionId, path);
          bytes += file.content.length * 2;
          if (!active || bytes > 8 * 1024 * 1024) throw new Error('重命名加载已取消或超过 8 MiB 上限');
          const tabs = useEditorTabs.getState();
          const draft = tabs.drafts[path];
          if (draft && draft.baseline !== file.content) throw new Error(`文件已变化，请重新加载：${path}`);
          tabs.syncDraft(path, file.content);
          const uri = monaco.Uri.parse(workspaceModelUri(sessionId, path));
          const model = monaco.editor.getModel(uri);
          const content = useEditorTabs.getState().drafts[path]?.content ?? file.content;
          if (!model) monaco.editor.createModel(content, monacoLang(path), uri);
          else if (!draft && model.getValue() !== content) model.setValue(content);
        }
        if (!active || !window.confirm(`重命名将修改 ${paths.length} 个文件：\n${paths.join('\n')}\n修改保留为未保存草稿。是否继续？`)) return false;
        useEditorTabs.setState((state) => ({ openFiles: [...new Set([...state.openFiles, ...paths])] }));
        return true;
      },
      prepareLocations: async (locations) => {
        // Peek widgets resolve text from Monaco models, not our file API. Load
        // only returned targets, leaving the rest of the repository on demand.
        const paths = [...new Set<string>(locations.map((item) => item.path).filter(Boolean))];
        let bytes = 0;
        for (const targetPath of paths.slice(0, 100)) {
          if (!active) return;
          const uri = monaco.Uri.parse(workspaceModelUri(sessionId, targetPath));
          if (monaco.editor.getModel(uri) && !queryClient.getQueryState(['file', sessionId, targetPath])?.isInvalidated) continue;
          try {
            const file = await queryClient.fetchQuery({ queryKey: ['file', sessionId, targetPath], queryFn: () => fetchWorkspaceFile(sessionId, targetPath), staleTime: Infinity });
            bytes += new TextEncoder().encode(file.content).byteLength;
            if (bytes > 8 * 1024 * 1024) { setLanguageError('引用预览达到加载上限，其他目标可从列表打开'); return; }
            if (active) {
              const draft = useEditorTabs.getState().drafts[targetPath];
              const dirty = draft && draft.content !== draft.baseline;
              const content = dirty ? draft.content : file.content;
              const existing = monaco.editor.getModel(uri);
              if (!existing) monaco.editor.createModel(content, monacoLang(targetPath), uri);
              else if (existing.getValue() !== content) existing.setValue(content);
              if (!targetPath.startsWith('@java-source/')) useEditorTabs.getState().syncDraft(targetPath, file.content);
            }
          } catch (error) { if (active) setLanguageError(workspaceLanguageError(error)); }
        }
        if (active && paths.length > 100) setLanguageError('引用预览仅加载前 100 个目标文件，其他目标可从列表打开');
      },
    });
    const modelListeners: any[] = [];
    const trackDraft = (model: any) => {
      const path = model.uri.authority === sessionId ? workspacePathFromUri(model.uri) : null;
      if (!path || path.startsWith('@java-source/')) return;
      modelListeners.push(model.onDidChangeContent(() => {
        if (active && useEditorTabs.getState().drafts[path]) useEditorTabs.getState().setDraftContent(path, model.getValue());
      }));
    };
    monaco.editor.getModels().forEach(trackDraft);
    const created = monaco.editor.onDidCreateModel(trackDraft);
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor: async (source: any, resource: any, selection: any) => {
        const targetPath = resource.authority === sessionId ? workspacePathFromUri(resource) : null;
        if (!targetPath) return false;
        // A peek editor is not the user's navigation origin. Keep history tied
        // to the main workspace editor, even when opening from a reference row.
        const origin = currentLocation(editorRef.current || source);
        // Reference search first asks Monaco to reveal the current symbol in
        // the same model. Let Monaco handle that without closing its new peek.
        if (origin?.path === targetPath && source === editorRef.current) return false;
        const originModel = editorRef.current?.getModel();
        const originVersion = originModel?.getVersionId();
        const requestId = ++navigationRequest.current;
        try {
          await queryClient.fetchQuery({ queryKey: ['file', sessionId, targetPath], queryFn: () => fetchWorkspaceFile(sessionId, targetPath), staleTime: Infinity });
          if (active && requestId === navigationRequest.current && sessionRef.current === sessionId && (!origin || (pathRef.current === origin.path && editorRef.current?.getModel() === originModel && originModel?.getVersionId() === originVersion))) {
            const target = editorLocation(targetPath, selection?.startLineNumber || selection?.lineNumber, selection?.startColumn || selection?.column);
            // Monaco's pinned peek navigation keeps its widget when an opener
            // reuses the same editor. A committed workspace jump should close
            // that preview, not leave stale references attached to the target.
            editorRef.current?.trigger('workspace-navigation', 'closeReferenceSearch', null);
            if (origin) useEditorTabs.getState().jumpToLocation(origin, target);
            else useEditorTabs.getState().openFile(target.path, target.line, target.column);
          }
        } catch (error) { if (active && sessionRef.current === sessionId) setLanguageError(workspaceLanguageError(error)); }
        return true;
      },
    });
    return () => {
      active = false;
      providers.dispose(); opener.dispose(); created.dispose(); modelListeners.forEach((listener) => listener.dispose());
      monaco.editor.getModels().filter((model: any) => model.uri.scheme === 'codegen' && model.uri.authority === sessionId).forEach((model: any) => model.dispose());
    };
  }, [monaco, sessionId, queryClient]);

  useEffect(() => {
    if (!monacoRef.current || !sessionId || !sourceIndex.data) return;
    const drafts = useEditorTabs.getState().drafts;
    syncWorkspaceModels(monacoRef.current, sessionId, sourceIndex.data.files.map((file) => ({
      ...file,
      content: drafts[file.path]?.content ?? file.content,
    })));
  }, [sessionId, sourceIndex.data]);

  useEffect(() => {
    if (!editorRef.current || !path || data?.path !== path || navigation?.path !== path || workspacePathFromUri(editorRef.current.getModel()?.uri) !== path) return;
    const position = { lineNumber: navigation.line, column: navigation.column };
    editorRef.current.setPosition(position);
    editorRef.current.revealPositionInCenter(position);
    editorRef.current.focus();
    clearNavigation();
  }, [path, data, navigation, clearNavigation]);

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
    if (!data || nonText) return;
    const stored = useEditorTabs.getState().drafts[data.path];
    const isNewFile = loadedPath.current !== data.path;
    const diskChanged = data.content !== stored?.baseline;
    const userDirty = !!stored && stored.content !== stored.baseline;
    if (!isNewFile && !(diskChanged && !userDirty)) return;

    loadedPath.current = data.path;
    setFormatErr("");
    setSaveErr("");
    const p = data.path;
    // 切回一个仍有未保存草稿的文件时，直接恢复草稿，不用磁盘内容覆盖。
    if (userDirty) return;
    if (!readOnly && autoFormatRef.current && canFormat(p)) {
      formatCode(data.content, p)
        .then(async (f) => {
          syncDraft(p, data.content);
          if (f !== data.content) {
            setDraftContent(p, f);
            await saveFile(p, f);
          }
        })
        .catch(() => {
          syncDraft(p, data.content);
        });
    } else {
      syncDraft(p, data.content);
    }
  }, [data, nonText, readOnly, syncDraft, setDraftContent]);

  const dirty = draft !== baseline;

  // 切换文件时始终默认「编辑」视图；想看本次改动再手动切到「改动」
  const modePathRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (modePathRef.current !== path) {
      modePathRef.current = path;
      setMode("edit");
    }
  }, [path]);

  async function saveFile(filePath: string, content: string) {
    if (filePath.startsWith('@java-source/')) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveErr("");
    try {
      const file = await fetchWorkspaceFile(sessionRef.current!, filePath);
      if (file.readOnly || (file.kind && file.kind !== 'text')) throw new Error('此文件仅支持预览，不能作为文本保存');
      const baseline = useEditorTabs.getState().drafts[filePath]?.baseline;
      if (baseline !== file.content) throw new Error('文件已变化，草稿已保留，请重新加载后重试');
      await save.mutateAsync({ path: filePath, content, expectedVersion: file.version });
      markDraftSaved(filePath, content);
    } catch (error) {
      const timedOut = (error as { code?: string })?.code === "ECONNABORTED";
      setSaveErr(timedOut ? "请求超时；请确认服务连接后重试，草稿仍保留" : errText(error));
    } finally {
      savingRef.current = false;
    }
  }

  async function saveAllDrafts() {
    const currentSession = sessionRef.current;
    if (!currentSession || savingRef.current) return;
    const drafts = Object.entries(useEditorTabs.getState().drafts).filter(([path, draft]) => !path.startsWith('@java-source/') && draft.content !== draft.baseline);
    if (!drafts.length) return;
    savingRef.current = true;
    setSaveErr('');
    let completed = 0;
    try {
      const versions = new Map<string, string | undefined>();
      for (const [path, draft] of drafts) {
        const file = await fetchWorkspaceFile(currentSession, path);
        if (file.readOnly || (file.kind && file.kind !== 'text')) throw new Error(`此文件仅支持预览，未开始保存：${path}`);
        if (file.content !== draft.baseline) throw new Error(`文件已变化，未开始保存：${path}`);
        versions.set(path, file.version);
      }
      for (const [path, draft] of drafts) {
        if (sessionRef.current !== currentSession) throw new Error('工作区已切换，保存已停止');
        await save.mutateAsync({ path, content: draft.content, expectedVersion: versions.get(path) });
        useEditorTabs.getState().markDraftSaved(path, draft.content);
        completed++;
      }
    } catch (error) { setSaveErr(`${errText(error)}${completed ? `；已保存 ${completed} 个文件，其余草稿保留` : ''}`); }
    finally { savingRef.current = false; }
  }

  function doSave() {
    if (readOnlyRef.current) return;
    const p = pathRef.current;
    const stored = p ? useEditorTabs.getState().drafts[p] : undefined;
    if (p && stored && stored.content !== stored.baseline) {
      const content = stored.content;
      void saveFile(p, content);
    }
  }

  async function doFormat() {
    if (readOnlyRef.current) return;
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
  const navigateMarkdown = useCallback((target: MarkdownNavigation) => {
    const position = editorRef.current?.getPosition();
    useEditorTabs.getState().jumpToLocation(editorLocation(path || target.path, position?.lineNumber || 1, position?.column || 1), editorLocation(target.path, target.line || 1, target.column || 1));
    setMarkdownTarget(target.anchor && monacoLang(target.path) === 'markdown' ? target : undefined);
  }, [path]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    blame.attach(editor);
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
    const modelListener = editor.onDidChangeModel(() => {
      const targetPath = workspacePathFromUri(editor.getModel()?.uri);
      if (targetPath && targetPath !== pathRef.current) openFile(targetPath);
      const pending = useEditorTabs.getState().navigation;
      if (pending?.path === targetPath && queryClient.getQueryData(['file', sessionRef.current, targetPath])) {
        requestAnimationFrame(() => {
          if (editor.getModel()?.uri.toString() !== workspaceModelUri(sessionRef.current!, pending.path) || useEditorTabs.getState().navigation !== pending) return;
          const position = { lineNumber: pending.line, column: pending.column };
          editor.setPosition(position); editor.revealPositionInCenter(position); editor.focus(); clearNavigation();
        });
      }
    });
    editor.onDidDispose(() => { modelListener.dispose(); if (editorRef.current === editor) editorRef.current = null; });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, doSave);
    // Shift+Alt+F 格式化（与 VS Code 一致）
    editor.addCommand(
      monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
      doFormat,
    );

    const navigateToDefinition = async (ed: any, requestedPosition?: any) => {
      const position = requestedPosition || ed.getPosition();
      const model = ed.getModel();
      const sourcePath = workspacePathFromUri(model?.uri);
      const currentSession = sessionRef.current;
      if (!position || !model || !sourcePath || !currentSession) return;
      if (!supportsWorkspaceLanguage(sourcePath)) return;
      const requestId = ++navigationRequest.current;
      const version = model.getVersionId();
      const isCurrent = () => requestId === navigationRequest.current && currentSession === sessionRef.current && ed.getModel() === model && !model.isDisposed() && model.getVersionId() === version && pathRef.current === sourcePath;
      try {
        setLanguageError('');
        const body = await requestWorkspaceLanguage(currentSession, 'definition', { path: sourcePath, content: model.getValue(), line: position.lineNumber, column: position.column });
        if (!isCurrent()) return;
        const values = Array.isArray(body.result) ? body.result : body.result ? [body.result] : [];
        const target = values.find((item: any) => item.path && item.path !== sourcePath) || values[0];
        const range = target?.range || target?.targetSelectionRange || target?.targetRange;
        if (!target?.path || !range) { setLanguageError('未找到该符号的定义'); return; }
        if (target.path !== sourcePath) {
          await queryClient.fetchQuery({ queryKey: ['file', currentSession, target.path], queryFn: () => fetchWorkspaceFile(currentSession, target.path), staleTime: Infinity });
          if (!isCurrent()) return;
          useEditorTabs.getState().jumpToLocation(editorLocation(sourcePath, position.lineNumber, position.column), editorLocation(target.path, range.start.line + 1, range.start.character + 1));
        } else {
          const location = { lineNumber: range.start.line + 1, column: range.start.character + 1 };
          useEditorTabs.getState().jumpToLocation(editorLocation(sourcePath, position.lineNumber, position.column), editorLocation(target.path, location.lineNumber, location.column));
          ed.setPosition(location); ed.revealPositionInCenter(location); ed.focus();
          clearNavigation();
        }
      } catch (error: any) {
        if (!isCurrent()) return;
        setLanguageError(workspaceLanguageError(error));
        if (error?.response?.data?.code === 'LSP_DISABLED' && ['typescript', 'javascript'].includes(model.getLanguageId())) ed.trigger('workspace', 'editor.action.revealDefinition', null);
      }
    };
    const mouseListener = editor.onMouseDown((event: any) => {
      const browserEvent = event.event?.browserEvent;
      if (!(browserEvent?.metaKey || browserEvent?.ctrlKey) || !event.target?.position) return;
      browserEvent.preventDefault();
      void navigateToDefinition(editor, event.target.position);
    });
    editor.onDidDispose(() => mouseListener.dispose());
    editor.addAction({
      id: "open-definition-in-tab",
      label: "转到定义",
      keybindings: [monaco.KeyCode.F12],
      run: (ed) => navigateToDefinition(ed),
    });
    editor.addAction({ id: 'workspace-navigation-back', label: '返回上一处代码', run: () => historyTravelRef.current(-1) });
    editor.addAction({ id: 'workspace-navigation-forward', label: '前进到下一处代码', run: () => historyTravelRef.current(1) });

    // 添加查找所有引用的命令
    editor.addAction({
      id: "find-all-references",
      label: "查找所有引用",
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      run: (ed) => {
        // Monaco 0.56 registers these through the command service, rather than
        // getAction(). Use the public trigger API and always show the results.
        ed.trigger('workspace', 'editor.action.referenceSearch.trigger', null);
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
      <GitBlameDetails item={blame.selected} onClose={blame.close} load={async (hash, signal) => (await api.get(`/sessions/${sessionId}/git/commits/${hash}/diff`, { signal })).data} />
      {/* 顶部工具条 */}
      <div className="panel flex min-h-[46px] items-center gap-3 border-b px-4">
        <div className="flex items-center gap-1">
          <button className="btn btn-ghost btn-sm px-1" aria-label="返回上一处代码" title={`返回上一处代码 (${shortcuts[0]})`} disabled={historyIndex < 1} onClick={() => void historyTravelRef.current(-1)}><ArrowLeft size={14} /></button>
          <button className="btn btn-ghost btn-sm px-1" aria-label="前进到下一处代码" title={`前进到下一处代码 (${shortcuts[1]})`} disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => void historyTravelRef.current(1)}><ArrowRight size={14} /></button>
        </div>
        <Select size="sm" ariaLabel="光标导航快捷键方案" value={navigationKeymap} options={[{ value: 'idea', label: 'IDEA 快捷键' }, { value: 'vscode', label: 'VS Code 快捷键' }, { value: 'eclipse', label: 'Eclipse 快捷键' }]} onChange={(value) => setNavigationKeymap(value as 'idea' | 'vscode' | 'eclipse')} />
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
        {saveErr && <span className="max-w-48 truncate text-[10px] text-red-500" title={saveErr}>保存失败：{saveErr}</span>}
        {readOnly && path.startsWith('@java-source/') && <span className="text-[10px] text-muted">依赖源码 · 只读</span>}
        {languageError && <span role="status" className="max-w-64 truncate text-[10px] text-amber-600" title={languageError}>{languageError}</span>}
        {sourceIndex.data?.truncated && (
          <span
            className="truncate text-[10px] text-amber-600 dark:text-amber-400"
            title="源码模型达到浏览器索引上限，部分跨文件跳转可能不可用"
          >
            部分源码未索引
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button className="btn btn-ghost btn-sm" disabled={nonText || nativeBlameUnsupported} title={nativeBlameUnsupported ? 'UTF-16 文件暂不支持 Git 行注释' : undefined} aria-pressed={blame.enabled} onClick={blame.toggle}>行注释</button>
          {blame.status && <span role="status" className="max-w-48 truncate text-[10px] text-muted" title={blame.status}>{blame.status}</span>}
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
              disabled={nonText}
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
          <button className="btn btn-sm" disabled={save.isPending} onClick={() => void saveAllDrafts()}>全部保存</button>
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
      {sqlScope && path && monacoLang(path) === 'sql' && mode === 'edit' && !nonText && <WorkspaceSqlBinding key={sqlScope} scope={sqlScope} preferenceKey={workspaceSqlScope('remote', sessionId!, me.data!.id)} content={draft} local={false} />}
      <div className="min-h-0 flex-1">
        {isLoading ? (
          <Center>加载中…</Center>
        ) : isError ? (
          <Center>无法读取该文件（可能过大或为二进制）</Center>
        ) : nonText && data && sessionId && path ? (
          <RemoteFilePreview sessionId={sessionId} path={path} view={{ kind: data.kind!, mime: data.mime || 'application/octet-stream', reason: data.reason, readOnly: true }} />
        ) : mode === "diff" && change ? (
          <DiffEditor
            key={"diff-" + path}
            language={monacoLang(path)}
            original={change.before}
            modified={draft}
            theme={editorTheme}
            options={{
              ...appearanceOptions,
              readOnly: true,
              renderSideBySide: true,
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        ) : (
          <WorkspaceFileViewer path={path || ''} view={{ kind: 'text', mime: data?.mime || 'text/plain', language: data?.language, encoding: data?.encoding, bom: data?.bom }} content={draft} loadMarkdownImage={loadMarkdownImage} onMarkdownNavigate={navigateMarkdown} markdownAnchor={markdownTarget?.path === path ? markdownTarget.anchor : undefined} onMarkdownAnchorApplied={markdownAnchorApplied}>
          <Editor
            key={sessionId}
            keepCurrentModel
            saveViewState
            path={sessionId ? workspaceModelUri(sessionId, path) : path}
            language={data?.language || monacoLang(path)}
            value={draft}
            onChange={(v) => { const current = pathRef.current; if (current && !current.startsWith('@java-source/')) setDraftContent(current, v ?? ""); }}
            onMount={handleMount}
            theme={editorTheme}
            options={{
              ...(blame.enabled ? baseAppearanceOptions : appearanceOptions),
              readOnly,
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
          </WorkspaceFileViewer>
        )}
      </div>
      {sessionId && <DesktopLanguageStatus projectId={sessionId} active includeFastIndex={!!path && monacoLang(path) === 'java'} prepareOnMount={false} transport={async (operation, signal) => (await api.post(`/sessions/${sessionId}/language/${operation}`, {}, { signal, timeout: 10000 })).data} indexTransport={async signal => (await api.post(`/sessions/${sessionId}/language/index-status`, {}, { signal, timeout: 10000 })).data} />}
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
