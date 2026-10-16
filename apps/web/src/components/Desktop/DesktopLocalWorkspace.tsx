import Editor, { useMonaco } from "@monaco-editor/react";
import { useEditorAppearance } from '../../hooks/useEditorAppearance';
import { EditorAppearanceSettings } from '../CodeEditor/EditorAppearanceSettings';
import { WorkspaceChatPanel } from '../CodeEditor/WorkspaceChatPanel';
import { ChatVisibilityButton } from '../CodeEditor/ChatVisibilityButton';
import { WorkspaceSqlBinding } from '../CodeEditor/WorkspaceSqlBinding';
import { workspaceSqlScope, readWorkspaceSqlContext } from '../../lib/workspace-sql-context';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { WorkspaceFileViewer } from '../CodeEditor/WorkspaceFileViewer';
import { WorkspaceFileIcon } from '../CodeEditor/WorkspaceFileIcon';
import type { MarkdownNavigation } from '../../lib/markdown-resource';
import { supportsWorkspaceLanguage } from '../../lib/workspace-language';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CaseSensitive,
  ChevronRight,
  CodeXml,
  Eye,
  File,
  FilePlus2,
  Pencil,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  LoaderCircle,
  RefreshCw,
  Regex,
  Save,
  Search,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import {
  installDesktopLanguageProviders,
  monacoLang,
  setupIntelliSense,
  workspaceModelUri,
  workspacePathFromUri,
} from "../../lib/monaco";
import { useTheme } from "../../store/theme";
import { useFolderExpansion } from '../../hooks/useFolderExpansion';
import { canFormatDocument, formatDocument } from '../../lib/format';
import { DesktopRestClient } from './DesktopRestClient';
import { DesktopLocalAgentPanel } from "./DesktopLocalAgentPanel";
import { DesktopLocalPreview } from "./DesktopLocalPreview";
import { DesktopLocalOutputPanel } from "./DesktopLocalOutputPanel";
import { DesktopLanguageStatus, isLanguageStartupError } from "./DesktopLanguageStatus";
import { useDesktopJavaRun, breakpointLine, breakpointCondition, breakpointHitCondition, breakpointLogMessage } from "./DesktopJavaRun";
import { Select } from "../common/Select";
import { useFeedback } from "../common/FeedbackProvider";
import { HistoryPanel } from "../HistoryPanel/HistoryPanel";
import { GitCompareModal, WorkingDiffModal } from '../SourceControl/GitCompareModal';
import { ConflictResolverModal } from '../HistoryPanel/ConflictResolverModal';
import type { GitHistoryTransport } from "../../hooks/useGit";
import { appendNavigation, restoreNavigation } from "../../lib/editor-navigation";
import { navigationDirection, navigationShortcuts } from "../../lib/editor-keymap";
import { useEditorPreferences } from "../../store/editorPreferences";
import { installWorkspaceRelations } from '../../lib/workspace-relations';
import { collectJavaDrafts } from '../../lib/fast-index-drafts';
import { buildWorkspaceFileTree } from '../../lib/workspace-file-tree';
import { verifyFastSymbolTarget, staleFastSymbol } from '../../lib/fast-symbol-target';
import { useGitBlame } from '../../hooks/useGitBlame';
import { GitBlameDetails } from '../CodeEditor/GitBlameDetails';

interface LocalProject {
  id: string;
  name: string;
  path: string;
  openedAt: string;
}
interface FileEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  depth: number;
}
interface SearchResult {
  path: string;
  line: number;
  column: number;
  preview: string;
}
interface NavigationEntry {
  path: string;
  line: number;
  column: number;
}
interface GitFile {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}
interface GitStatus {
  conflicts?: string[];
  mergeInProgress?: boolean;
  repository: boolean;
  branch: string | null;
  head?: string | null;
  upstream?: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}
interface GitRefs {
  branches: string[];
  remotes: string[];
}
interface LocalTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: LocalTreeNode[];
}
interface SymbolResult {
  name: string;
  kind: string;
  path: string;
  line: number;
  column: number;
  hash?: string;
  hashSource?: 'disk' | 'overlay';
}
interface FileView {
  readOnly?: boolean;
  kind: "text" | "image" | "pdf" | "spreadsheet" | "unsupported";
  mime: string;
  reason?: string;
  sheets?: Array<{ name: string; rows: string[][] }>;
  truncated?: boolean;
  language?: string;
  preview?: string;
  encoding?: string;
  bom?: boolean;
}
interface OpenFileState {
  path: string;
  content: string;
  savedContent: string;
  version: string;
  view: FileView;
}
type EverywhereItem =
  | { type: "file"; label: string; detail: string; path: string }
  | {
      type: "text" | "symbol";
      label: string;
      detail: string;
      path: string;
      line: number;
      column: number;
      hash?: string;
      hashSource?: 'disk' | 'overlay';
    }
  | {
      type: "action";
      label: string;
      detail: string;
      action: "files" | "git" | "save" | "refreshGit";
    };

export function DesktopLocalWorkspace({
  project,
  onBack,
  active = true,
}: {
  project: LocalProject;
  onBack: () => void;
  active?: boolean;
}) {
  const theme = useTheme((state) => state.theme);
  const { editorTheme, appearanceOptions, baseAppearanceOptions } = useEditorAppearance(useMonaco(), theme);
  const { prompt: askPrompt, confirm: askConfirm } = useFeedback();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [fileStates, setFileStates] = useState<Record<string, OpenFileState>>(
    {},
  );
  const [content, setContent] = useState("");
  const [fileView, setFileView] = useState<FileView>({
    kind: "text",
    mime: "text/plain",
  });
  const [savedContent, setSavedContent] = useState("");
  const [fileVersion, setFileVersion] = useState("");
  const [externalChanged, setExternalChanged] = useState(false);
  const [loadingTree, setLoadingTree] = useState(true);
  const [indexTruncated, setIndexTruncated] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [movingFile, setMovingFile] = useState(false);
  const [markdownTarget, setMarkdownTarget] = useState<MarkdownNavigation>();
  const markdownRequest = useRef(0);
  useEffect(() => () => { markdownRequest.current++; }, [project.id]);
  const [error, setError] = useState("");
  const [formatting, setFormatting] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [glob, setGlob] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickSelection, setQuickSelection] = useState(0);
  const [everywhereResults, setEverywhereResults] = useState<
    Array<SearchResult | SymbolResult>
  >([]);
  const [everywhereLoading, setEverywhereLoading] = useState(false);
  const [everywhereNotice, setEverywhereNotice] = useState('');
  const [everywhereReload, setEverywhereReload] = useState(0);
  const symbolTargetSequence = useRef(0);
  const quickContextRef = useRef({ quickOpen, quickQuery, projectId: project.id });
  quickContextRef.current = { quickOpen, quickQuery, projectId: project.id };
  useEffect(() => () => { symbolTargetSequence.current++; }, [project.id]);
  const [navigation, setNavigation] = useState<NavigationEntry[]>([]);
  const [navigationIndex, setNavigationIndex] = useState(-1);
  const { navigationKeymap, setNavigationKeymap } = useEditorPreferences();
  const shortcuts = navigationShortcuts(navigationKeymap, navigator.platform);
  const [sidebarMode, setSidebarMode] = useState<"files" | "git">("files");
  const [workspaceTab, setWorkspaceTab] = useState<
    "code" | "preview" | "history" | "rest"
  >("code");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [restOpened, setRestOpened] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus>();
  const [gitLoading, setGitLoading] = useState(false);
  const [gitSelection, setGitSelection] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [gitDiff, setGitDiff] = useState<{
    path: string;
  }>();
  const [showGitCompare, setShowGitCompare] = useState(false);
  const [showGitResolver, setShowGitResolver] = useState(false);
  const [mergeBranch, setMergeBranch] = useState('');
  const [gitRefs, setGitRefs] = useState<GitRefs>({
    branches: [],
    remotes: [],
  });
  const [gitRemote, setGitRemote] = useState("");
  const [target, setTarget] = useState<{ line: number; column: number }>();
  const [editor, setEditor] = useState<any>();
  const [monaco, setMonaco] = useState<any>();
  const activePathRef = useRef<string>();
  const runPanelSize = useRef(35);
  const openFileRef = useRef<
    (
      path: string,
      line?: number,
      column?: number,
      record?: boolean,
    ) => Promise<boolean>
  >(async () => false);
  const javaRun = useDesktopJavaRun(project.id, files.some((file) => file.path.endsWith(".java")), active,
    Object.values(fileStates).some((file) => !file.view.readOnly && file.content !== file.savedContent),
    (frame) => { setWorkspaceTab("code"); if (frame.path) void openFileRef.current(frame.path, frame.line, frame.column); });
  const navigateMarkdown = useCallback(async (target: MarkdownNavigation) => {
    const request = ++markdownRequest.current;
    setMarkdownTarget(undefined); setWorkspaceTab('code');
    const opened = await openFileRef.current(target.path, target.line, target.column);
    if (opened && request === markdownRequest.current && target.anchor && monacoLang(target.path) === 'markdown') setMarkdownTarget(target);
  }, []);
  const markdownAnchorApplied = useCallback(() => setMarkdownTarget(undefined), []);
  useEffect(() => {
    if (!monaco) return;
    const listeners = new Map<any, { dispose: () => void }>();
    const attach = (model: any) => {
      const path = workspacePathFromUri(model.uri);
      if (!path?.endsWith('.java') || path.startsWith('@java-source/') || model.uri.authority !== project.id || listeners.has(model)) return;
      let previousVersion = model.getAlternativeVersionId();
      const change = model.onDidChangeContent((event: any) => {
        const version = model.getAlternativeVersionId();
        const state = fileStatesRef.current[path];
        if (event.isFlush || (state && !state.view.readOnly)) {
          if (!event.isFlush && state) {
            const content = model.getValue();
            const next = { ...fileStatesRef.current, [path]: { ...state, content } };
            fileStatesRef.current = next; setFileStates(next);
            if (activePathRef.current === path) setContent(content);
          }
          javaRun.migrateBreakpoint.current(path, event.changes, previousVersion, version, event.isUndoing || event.isRedoing, event.isFlush);
        }
        previousVersion = version;
      });
      const dispose = model.onWillDispose(() => { change.dispose(); dispose.dispose(); listeners.delete(model); javaRun.migrateBreakpoint.current(path, [], 0, 0, false, true); });
      listeners.set(model, { dispose: () => { change.dispose(); dispose.dispose(); } });
    };
    monaco.editor.getModels().forEach(attach);
    const created = monaco.editor.onDidCreateModel(attach);
    return () => { created.dispose(); listeners.forEach(listener => listener.dispose()); };
  }, [monaco, project.id]);
  useEffect(() => {
    if (!editor || !monaco || !activePath) return;
    const collection = editor.createDecorationsCollection();
    const render = () => {
      if (workspacePathFromUri(editor.getModel()?.uri) !== activePath) { collection.clear(); return; }
      collection.set([
      ...(activePath.endsWith('.java') && !activePath.startsWith('@java-source/') ? [monaco.editor.GlyphMarginLane.Center, monaco.editor.GlyphMarginLane.Right].map(position => ({ range: new monaco.Range(1, 1, 1, 1), options: { glyphMarginClassName: 'desktop-java-debug-lane', glyphMargin: { position, persistLane: true } } })) : []),
      ...(javaRun.breakpoints[activePath] || []).map((point) => ({ range: new monaco.Range(breakpointLine(point), 1, breakpointLine(point), 1), options: { isWholeLine: false, glyphMargin: { position: monaco.editor.GlyphMarginLane.Center, persistLane: true }, glyphMarginClassName: `desktop-java-breakpoint${breakpointCondition(point) || breakpointHitCondition(point) ? ' desktop-java-breakpoint-conditional' : ''}${breakpointLogMessage(point) ? ' desktop-java-logpoint' : ''}`, glyphMarginHoverMessage: { value: ['断点（点击移除，右键编辑）', breakpointCondition(point) && `条件：${breakpointCondition(point)}`, breakpointHitCondition(point) && `命中次数：${breakpointHitCondition(point)}`, breakpointLogMessage(point) && `日志：${breakpointLogMessage(point)}`].filter(Boolean).join('\n\n') } } })),
      ...(javaRun.pausedFrame?.path === activePath ? [{ range: new monaco.Range(javaRun.pausedFrame.line, 1, javaRun.pausedFrame.line, 1), options: { isWholeLine: true, className: "desktop-java-current-line", glyphMarginClassName: 'desktop-java-execution-pointer', glyphMargin: { position: monaco.editor.GlyphMarginLane.Right, persistLane: true } } }] : []),
      ]);
    };
    const changed = editor.onDidChangeModel(render);
    render();
    return () => { changed.dispose(); collection.clear(); };
  }, [editor, monaco, activePath, javaRun.breakpoints, javaRun.pausedFrame]);
  const openRequestRef = useRef(0);
  const treeRevisionRef = useRef(0);
  const navigationRef = useRef<NavigationEntry[]>([]);
  const navigationIndexRef = useRef(-1);
  const editorRef = useRef<any>();
  const fileStatesRef = useRef(fileStates);
  fileStatesRef.current = fileStates;
  async function formatActiveFile() {
    const editor = editorRef.current, model = editor?.getModel();
    const file = workspacePathFromUri(model?.uri);
    if (!file || !canFormatDocument(file) || fileStatesRef.current[file]?.view.readOnly || formatting) return;
    const snapshot = model.getValue(), version = model.getVersionId(); setFormatting(true); setError('');
    try {
      const formatted = await formatDocument(snapshot, file, async input => {
        const response = await fetch(`/api/local/projects/${project.id}/language/format`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
        const body = await response.json(); if (!response.ok) throw Error(body.message || '语言服务格式化失败'); return body;
      });
      if (model.isDisposed() || editor.getModel() !== model || model.getVersionId() !== version) throw Error('格式化期间文件已变化，请重试');
      editor.pushUndoStop(); editor.executeEdits('format-document', [{ range: model.getFullModelRange(), text: formatted }]); editor.pushUndoStop();
    } catch (reason: any) { setError(reason.message || '格式化失败'); } finally { setFormatting(false); }
  }
  const formatActiveRef = useRef(formatActiveFile); formatActiveRef.current = formatActiveFile;
  const refreshGitFilesRef = useRef<() => Promise<void>>(async () => {});
  const historyTransport = useMemo<GitHistoryTransport>(() => {
    const base = `/api/local/projects/${project.id}/git`;
    const request = async (url: string, options?: RequestInit) => {
      const response = await fetch(url, options);
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      return body;
    };
    return {
      scope: `${project.id}:${gitStatus?.branch || 'detached'}:${gitStatus?.head || ''}`,
      commits: (offset, signal) => request(`${base}/commits?offset=${offset}`, { signal }),
      diff: (hash, signal) => request(`${base}/commits/${hash}/diff`, { signal }),
      rollback: async (hash) => {
        if (Object.values(fileStatesRef.current).some(file => !file.view.readOnly && file.content !== file.savedContent)) throw new Error('请先保存编辑器中的修改，再恢复历史版本');
        const result = await request(`${base}/rollback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash }) });
        await refreshGitFilesRef.current();
        return result;
      },
    };
  }, [project.id, gitStatus?.branch, gitStatus?.head]);
  useEffect(() => {
    const checkQuit = (event: Event) => {
      if (Object.values(fileStatesRef.current).some((file) => !file.view.readOnly && file.content !== file.savedContent)) (event as CustomEvent).detail.dirty = true;
    };
    window.addEventListener('code-studio:quit-check', checkQuit);
    return () => window.removeEventListener('code-studio:quit-check', checkQuit);
  }, []);
  const viewStatesRef = useRef(new Map<string, any>());
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const cursorCheckpointRef = useRef<NavigationEntry>();
  const movingHistoryRef = useRef(false);
  const dirty = content !== savedContent;
  useEffect(() => {
    if (!active) { setQuickOpen(false); return; }
    const frame = requestAnimationFrame(() => editor?.layout());
    return () => cancelAnimationFrame(frame);
  }, [active, editor]);
  activePathRef.current = activePath;
  navigationRef.current = navigation;
  navigationIndexRef.current = navigationIndex;

  const quickFiles = useMemo(() => {
    if (['@', '#', '>'].includes(quickQuery[0])) return [];
    const candidates = files.filter((entry) => entry.type === "file");
    const query = quickQuery.trim().toLowerCase();
    if (!query) return candidates.slice(0, 100);
    const parts = query.split(/\s+/).filter(Boolean);
    return candidates
      .filter((entry) =>
        parts.every((part) => entry.path.toLowerCase().includes(part)),
      )
      .sort((left, right) => {
        const leftName = left.name.toLowerCase();
        const rightName = right.name.toLowerCase();
        const leftExact =
          leftName === query ? 0 : leftName.startsWith(query) ? 1 : 2;
        const rightExact =
          rightName === query ? 0 : rightName.startsWith(query) ? 1 : 2;
        return leftExact - rightExact || left.path.length - right.path.length;
      })
      .slice(0, 100);
  }, [files, quickQuery]);

  const everywhereItems = useMemo<EverywhereItem[]>(() => {
    const prefix = quickQuery[0];
    const query = quickQuery.slice(1).trim().toLowerCase();
    if (prefix === ">") {
      const actions: EverywhereItem[] = [
        {
          type: "action",
          label: "显示文件",
          detail: "切换到文件与搜索侧栏",
          action: "files",
        },
        {
          type: "action",
          label: "显示源代码管理",
          detail: "切换到本地 Git 侧栏",
          action: "git",
        },
        {
          type: "action",
          label: "保存当前文件",
          detail: "Cmd/Ctrl+S",
          action: "save",
        },
        {
          type: "action",
          label: "刷新 Git 状态",
          detail: "重新读取本地仓库",
          action: "refreshGit",
        },
      ];
      return actions.filter(
        (item) =>
          !query ||
          `${item.label} ${item.detail}`.toLowerCase().includes(query),
      );
    }
    if (prefix === "@")
      return (everywhereResults as SymbolResult[]).map((item) => ({
        type: "symbol",
        label: item.name,
        detail: `${item.kind} · ${item.path}:${item.line}`,
        path: item.path,
        line: item.line,
        column: item.column,
        hash: item.hash,
        hashSource: item.hashSource,
      }));
    if (prefix === "#")
      return (everywhereResults as SearchResult[]).map((item) => ({
        type: "text",
        label: item.preview.trim() || item.path,
        detail: `${item.path}:${item.line}:${item.column}`,
        path: item.path,
        line: item.line,
        column: item.column,
      }));
    return quickFiles.map((item) => ({
      type: "file",
      label: item.name,
      detail: item.path,
      path: item.path,
    }));
  }, [quickQuery, quickFiles, everywhereResults]);

  useEffect(() => {
    void fetch(`/api/local/projects/${project.id}/files`)
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            (await response.json()).message || `HTTP ${response.status}`,
          );
        const body = (await response.json()) as { items: FileEntry[]; revision: number };
        treeRevisionRef.current = body.revision;
        setFiles(body.items);
      })
      .catch((reason) => setError(String(reason?.message || reason)))
      .finally(() => setLoadingTree(false));
  }, [project.id]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/local/projects/${project.id}/files?since=${treeRevisionRef.current}`, { signal: controller.signal });
        if (!response.ok) return;
        const body = await response.json();
        if (!body.notModified && !controller.signal.aborted) {
          treeRevisionRef.current = body.revision;
          setFiles(body.items);
        }
      } catch { /* Background refresh must not interrupt editing. */ }
    }, 30_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [active, project.id]);

  useEffect(() => {
    if (sidebarMode === "git" || workspaceTab === "code") void loadGitStatus();
  }, [sidebarMode, workspaceTab, project.id]);

  useEffect(() => {
    if (!monaco) return;
    let disposed = false;
    const editListeners = new Map<string, any>();
    const providers = installDesktopLanguageProviders(monaco, project.id, async (operation, input) => {
      const response = await fetch(`/api/local/projects/${project.id}/language/${operation}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, documents: dirtyDocuments(String(input.path || '')) }),
      });
      if (!response.ok) { const body = await response.json(); throw Object.assign(new Error(body.message || '代码智能请求失败'), { code: body.code }); }
      return response.json();
    }, {
      sqlContext: () => readWorkspaceSqlContext(workspaceSqlScope('local', project.id)),
      onError: (reason: any) => { if (!isLanguageStartupError(reason)) setError(reason?.message || '代码智能请求失败，请重试'); },
      prepareEdits: async (edit) => {
        const paths = [...new Set<string>(edit.edits.map((file: any) => file.path))];
        if (paths.length > 100 || paths.some((path) => path.startsWith('@java-source/'))) throw new Error('重命名超出可编辑范围，未应用修改');
        const staged: OpenFileState[] = [];
        const versions = new Map<string, number>();
        let bytes = 0;
        for (const path of paths) {
          const response = await fetch(`/api/local/projects/${project.id}/content?path=${encodeURIComponent(path)}`);
          if (!response.ok) throw new Error(`无法读取重命名目标：${path}`);
          const body = await response.json();
          if (typeof body.content !== 'string' || body.readOnly || body.kind !== 'text') throw new Error(`文件不可编辑：${path}`);
          bytes += body.content.length * 2;
          if (bytes > 8 * 1024 * 1024) throw new Error('重命名文件内容超过 8 MiB，未应用修改');
          const current = fileStatesRef.current[path];
          if (current && current.version !== body.version) throw new Error(`磁盘文件已变化，请先重新加载：${path}`);
          const uri = monaco.Uri.parse(workspaceModelUri(project.id, path));
          let model = monaco.editor.getModel(uri);
          // An old preview model is not a draft. Refresh it before applying the
          // language service's ranges, but never replace an open unsaved buffer.
          if (!model) model = monaco.editor.createModel(current?.content ?? body.content, monacoLang(path), uri);
          else if (!current && model.getValue() !== body.content) model.setValue(body.content);
          versions.set(path, model.getVersionId());
          staged.push(current || { path, content: body.content, savedContent: body.content, version: body.version, view: body });
        }
        if (disposed || !window.confirm(`重命名将修改 ${paths.length} 个文件：\n${paths.join('\n')}\n\n修改将保留为未保存草稿，可撤销。是否继续？`)) return false;
        for (const path of paths) {
          const model = monaco.editor.getModel(monaco.Uri.parse(workspaceModelUri(project.id, path)));
          if (!model || model.getVersionId() !== versions.get(path)) throw new Error('重命名期间代码发生变化，请重新执行');
        }
        const next = { ...fileStatesRef.current };
        for (const state of staged) next[state.path] = state;
        fileStatesRef.current = next;
        setFileStates(next);
        setOpenFiles((current) => [...new Set([...current, ...paths])]);
        for (const path of paths) {
          if (editListeners.has(path)) continue;
          const model = monaco.editor.getModel(monaco.Uri.parse(workspaceModelUri(project.id, path)));
          editListeners.set(path, model.onDidChangeContent(() => {
            const state = fileStatesRef.current[path];
            if (!state || disposed) return;
            const content = model.getValue();
            const next = { ...fileStatesRef.current, [path]: { ...state, content } };
            fileStatesRef.current = next;
            setFileStates(next);
            if (activePathRef.current === path) setContent(content);
          }));
        }
        return true;
      },
      prepareLocations: async (locations) => {
        const paths = [...new Set(locations.map((item: any) => item.path).filter(Boolean))].slice(0, 100) as string[];
        // Native implementation/reference pickers must be able to resolve their
        // target models. Bound concurrency, and never overwrite dirty models.
        let next = 0;
        let bytes = 0;
        await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
          while (next < paths.length && !disposed) {
            const path = paths[next++];
            const uri = monaco.Uri.parse(workspaceModelUri(project.id, path));
            if (monaco.editor.getModel(uri)) continue;
            const response = await fetch(`/api/local/projects/${project.id}/${path.startsWith('@java-source/') ? 'language/source' : 'content'}?path=${encodeURIComponent(path)}`);
            if (!response.ok) continue;
            const body = await response.json();
            if (typeof body.content !== 'string') continue;
            bytes += body.content.length * 2;
            if (bytes > 8 * 1024 * 1024) break;
            if (!disposed && !monaco.editor.getModel(uri)) monaco.editor.createModel(body.content, monacoLang(path), uri);
          }
        }));
        const retained = new Set([...Object.keys(fileStatesRef.current), ...paths]);
        const previews = monaco.editor.getModels().filter((model: any) => model.uri.authority === project.id && !retained.has(workspacePathFromUri(model.uri) || ''));
        let total = previews.reduce((sum: number, model: any) => sum + model.getValueLength() * 2, 0);
        while (previews.length > 100 || total > 8 * 1024 * 1024) {
          const model = previews.shift();
          total -= model.getValueLength() * 2;
          model.dispose();
        }
      },
    });
    const opener = monaco.editor.registerEditorOpener({ openCodeEditor: async (_source: any, uri: any, selection: any) => {
      if (disposed || uri.scheme !== 'codegen' || uri.authority !== project.id) return false;
      const path = workspacePathFromUri(uri);
      if (!path) return false;
      await openFileRef.current(path, selection?.startLineNumber || selection?.lineNumber || 1, selection?.startColumn || selection?.column || 1);
      return true;
    } });
    return () => {
      disposed = true; providers.dispose(); opener.dispose();
      editListeners.forEach((listener) => listener.dispose());
      for (const model of monaco.editor.getModels()) if (model.uri.authority === project.id) model.dispose();
    };
  }, [monaco, project.id]);

  useEffect(() => {
    if (
      !quickOpen ||
      !["@", "#"].includes(quickQuery[0]) ||
      !quickQuery.slice(1).trim()
    ) {
      setEverywhereResults([]);
      setEverywhereLoading(false);
      setEverywhereNotice('');
      return;
    }
    const controller = new AbortController();
    setEverywhereNotice('');
    let timer: number;
    const search = async () => {
      setEverywhereLoading(true);
      try {
        const query = encodeURIComponent(quickQuery.slice(1).trim());
        const endpoint =
          quickQuery[0] === "@"
            ? 'symbols'
            : `search?query=${query}&regex=false&caseSensitive=false`;
        const response = await fetch(
          `/api/local/projects/${project.id}/${endpoint}`,
          { signal: controller.signal, ...(quickQuery[0] === '@' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: quickQuery.slice(1).trim(), documents: collectJavaDrafts(Object.values(fileStatesRef.current).map(file => ({ path: file.path, content: file.content, baseline: file.savedContent, readOnly: file.view.readOnly }))) }) } : {}) },
        );
        const body = await response.json();
        if (body.code === 'FAST_INDEX_BUSY' && !controller.signal.aborted) {
          setEverywhereNotice('正在等待索引资源…');
          timer = window.setTimeout(search, 2_000);
          return;
        }
        if (!response.ok)
          throw new Error(body.message || `HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        setEverywhereResults(body.items);
        const indexing = body.index && ['starting', 'scanning', 'needs-scan', 'needs-validation'].includes(body.index.state);
        setEverywhereNotice(indexing ? `正在更新代码索引 · 已索引 ${body.index.files || 0} 个文件…` : body.overlayTruncated ? '未保存代码索引未完整，请保存文件后重试。' : body.sourceTruncated ? `当前搜索覆盖 ${body.sourceFiles} 个源码文件，尚未覆盖整个项目。` : body.truncated ? '结果较多，当前仅显示部分匹配，请缩小搜索范围。' : '');
        if (indexing) timer = window.setTimeout(search, 2_000);
      } catch (reason: any) {
        if (reason?.name !== "AbortError")
          setError(String(reason?.message || reason));
      } finally {
        if (!controller.signal.aborted) setEverywhereLoading(false);
      }
    };
    timer = window.setTimeout(search, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [quickOpen, quickQuery, project.id, fileStates, everywhereReload]);

  useEffect(() => {
    if (!monaco) return;
    const controller = new AbortController();
    void fetch(`/api/local/projects/${project.id}/index?metadata=true`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{
          files: Array<{ path: string; content: string }>;
          truncated: boolean;
        }>;
      })
      .then((sourceIndex) => {
        setIndexTruncated(sourceIndex.truncated);
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError")
          setError("代码索引加载失败，文本编辑仍可使用。");
      });
    return () => controller.abort();
  }, [monaco, project.id]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!active) return;
      const direction = navigationDirection(navigationKeymap, navigator.platform, event);
      if (direction && workspaceTab === 'code' && !(event.target instanceof HTMLElement && event.target.closest('input, select, [role="dialog"]'))) {
        event.preventDefault();
        event.stopPropagation();
        void moveInHistory(direction);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && !saving) void save();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setQuickOpen(true);
        setQuickQuery(event.shiftKey ? ">" : "");
        setQuickSelection(0);
      }
      if (event.key === "Escape") setQuickOpen(false);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });

  useEffect(() => {
    const query = searchInput.trim();
    if (!query) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({
          query,
          regex: String(regex),
          caseSensitive: String(caseSensitive),
        });
        if (glob.trim()) params.set("glob", glob.trim());
        const response = await fetch(
          `/api/local/projects/${project.id}/search?${params}`,
          { signal: controller.signal },
        );
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.message || `HTTP ${response.status}`);
        setSearchResults(body.items);
        setError("");
      } catch (reason: any) {
        if (reason?.name !== "AbortError")
          setError(String(reason?.message || reason));
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [project.id, searchInput, regex, caseSensitive, glob]);

  useEffect(() => {
    if (!active || !editor || !target || loadingFile) return;
    // A file load can unmount Monaco. Wait for the replacement editor/model,
    // rather than consuming the target on the previous (disposed) instance.
    const model = editor.getModel();
    if (!activePath || !model || model.isDisposed() || workspacePathFromUri(model.uri) !== activePath || !editor.getDomNode()?.isConnected) return;
    editor.setPosition({ lineNumber: target.line, column: target.column });
    editor.revealPositionInCenter({
      lineNumber: target.line,
      column: target.column,
    });
    editor.focus();
    setTarget(undefined);
  }, [active, editor, target, loadingFile, activePath]);

  useEffect(() => {
    if (!editor || !activePath || loadingFile) return;
    const restore = () => {
      if (workspacePathFromUri(editor.getModel()?.uri) !== activePath) return;
      if (!target) {
        const state = viewStatesRef.current.get(activePath);
        if (state) editor.restoreViewState(state);
      }
      const position = editor.getPosition();
      if (position) cursorCheckpointRef.current = { path: activePath, line: position.lineNumber, column: position.column };
    };
    const frame = requestAnimationFrame(restore);
    const listener = editor.onDidChangeModel(restore);
    return () => { cancelAnimationFrame(frame); listener.dispose(); };
  }, [editor, activePath, loadingFile]);

  function currentCursor(): NavigationEntry | undefined {
    const instance = editorRef.current;
    const path = workspacePathFromUri(instance?.getModel()?.uri);
    const position = instance?.getPosition();
    return path && position ? { path, line: position.lineNumber, column: position.column } : undefined;
  }

  function dirtyDocuments(exclude: string) {
    let bytes = 0;
    return Object.values(fileStatesRef.current).filter((file) => {
      if (file.path === exclude || file.view.readOnly || file.content === file.savedContent || !supportsWorkspaceLanguage(file.path)) return false;
      bytes += file.content.length * 2;
      return bytes <= 1024 * 1024;
    }).slice(0, 20).map((file) => ({ path: file.path, content: file.content }));
  }

  function commitHistory(entries: NavigationEntry[], index: number) {
    navigationRef.current = entries;
    navigationIndexRef.current = index;
    setNavigation(entries);
    setNavigationIndex(index);
  }

  function recordNavigation(origin: NavigationEntry | undefined, destination: NavigationEntry) {
    if (movingHistoryRef.current) return;
    const result = appendNavigation({ entries: navigationRef.current, index: navigationIndexRef.current }, origin || destination, destination);
    if (!result.entries.length) commitHistory([destination], 0);
    else commitHistory(result.entries, result.index);
    cursorCheckpointRef.current = destination;
  }

  useEffect(() => {
    if (!active || !activePath || activePath.startsWith('@java-source/') || !fileVersion || loadingFile || externalChanged) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(
          `/api/local/projects/${project.id}/content?metadata=true&path=${encodeURIComponent(activePath)}`,
        );
        if (!response.ok) return;
        const metadata = (await response.json()) as { version: string };
        if (metadata.version !== fileVersion) {
          if (dirty) {
            setExternalChanged(true);
            setError(
              "文件已被其他程序修改。请重新加载磁盘版本，当前未保存内容不会被自动覆盖。",
            );
          } else void openFile(activePath, undefined, undefined, false);
        }
      } catch {}
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [
    active,
    activePath,
    fileVersion,
    loadingFile,
    externalChanged,
    dirty,
    project.id,
  ]);

  async function openFile(
    path: string,
    line?: number,
    column?: number,
    record = true,
  ) {
    clearTimeout(cursorTimerRef.current);
    const origin = currentCursor();
    if (origin) viewStatesRef.current.set(origin.path, editorRef.current.saveViewState());
    const remember = () => { if (record) recordNavigation(origin, { path, line: line || 1, column: column || 1 }); };
    const requestId = ++openRequestRef.current;
    const cached = fileStatesRef.current[path];
    if (path === activePathRef.current && cached && line) {
      // Debug/definition navigation within the current file must not reload it
      // from disk or discard edits made while paused.
      setTarget({ line, column: column || 1 });
      remember();
      return true;
    }
    if (path !== activePathRef.current && cached) {
      setLoadingFile(false);
      setActivePath(path);
      setContent(cached.content);
      setSavedContent(cached.savedContent);
      setFileVersion(cached.version);
      setFileView(cached.view);
      setExternalChanged(false);
      if (line) setTarget({ line, column: column || 1 });
      remember();
      return true;
    }
    setLoadingFile(true);
    setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(
        `/api/local/projects/${project.id}/${path.startsWith('@java-source/') ? 'language/source' : 'content'}?path=${encodeURIComponent(path)}`,
        { signal: controller.signal },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message || `HTTP ${response.status}`);
      if (requestId !== openRequestRef.current) return false;
      const nextView: FileView = {
        kind: body.kind || "text",
        mime: body.mime || "application/octet-stream",
        reason: body.reason,
        readOnly: Boolean(body.readOnly),
        language: body.language,
        preview: body.preview,
        encoding: body.encoding,
        bom: body.bom,
      };
      if (nextView.kind === "spreadsheet") {
        const sheetResponse = await fetch(
          `/api/local/projects/${project.id}/spreadsheet?path=${encodeURIComponent(path)}`,
          { signal: controller.signal },
        );
        const sheetBody = await sheetResponse.json();
        if (!sheetResponse.ok)
          throw new Error(sheetBody.message || `HTTP ${sheetResponse.status}`);
        nextView.sheets = sheetBody.sheets;
        nextView.truncated = sheetBody.truncated;
      }
      if (requestId !== openRequestRef.current) return false;
      const nextContent = typeof body.content === "string" ? body.content : "";
      // keepCurrentModel retains Monaco models across editor unmounts. A disk
      // reload (especially checkout) must update that retained model as well.
      const retainedModel = monaco?.editor.getModel(monaco.Uri.parse(workspaceModelUri(project.id, path)));
      if (retainedModel && retainedModel.getValue() !== nextContent) retainedModel.setValue(nextContent);
      setActivePath(path);
      setFileView(nextView);
      setContent(nextContent);
      setSavedContent(nextContent);
      setFileVersion(body.version);
      setExternalChanged(false);
      setOpenFiles((current) =>
        current.includes(path) ? current : [...current, path],
      );
      setFileStates((current) => ({
        ...current,
        [path]: {
          path,
          content: nextContent,
          savedContent: nextContent,
          version: body.version,
          view: nextView,
        },
      }));
      if (line) setTarget({ line, column: column || 1 });
      remember();
      return true;
    } catch (reason: any) {
      if (requestId === openRequestRef.current)
        setError(
          reason?.name === "AbortError"
            ? "文件读取超时，请重试。"
            : String(reason?.message || reason),
        );
      return false;
    } finally {
      window.clearTimeout(timeout);
      if (requestId === openRequestRef.current) setLoadingFile(false);
    }
  }
  openFileRef.current = openFile;

  async function closeFile(path: string) {
    // Do not discard a buffer while an in-flight save can still advance disk.
    if (saving || movingFile) return;
    const state = fileStates[path];
    if (
      state &&
      state.content !== state.savedContent &&
      !window.confirm(`“${path.split("/").pop()}”尚未保存，确定关闭吗？`)
    )
      return;
    if (state && state.content !== state.savedContent) javaRun.discardBreakpointEdits.current(path);
    const index = openFiles.indexOf(path);
    const nextFiles = openFiles.filter((item) => item !== path);
    setOpenFiles(nextFiles);
    setFileStates((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    if (path === activePath) {
      const nextPath = nextFiles[Math.min(index, nextFiles.length - 1)];
      if (nextPath) await openFile(nextPath, undefined, undefined, false);
      else {
        setActivePath(undefined);
        setContent("");
        setSavedContent("");
      }
    }
  }

  async function moveInHistory(offset: number) {
    if (movingHistoryRef.current) return;
    const nextIndex = navigationIndexRef.current + offset;
    const entry = navigationRef.current[nextIndex];
    if (!entry) return;
    const history = restoreNavigation({ entries: navigationRef.current, index: navigationIndexRef.current }, nextIndex, currentCursor());
    movingHistoryRef.current = true;
    try {
      if (await openFile(entry.path, entry.line, entry.column, false)) {
        commitHistory(history.entries, history.index);
        cursorCheckpointRef.current = entry;
      }
    } finally { movingHistoryRef.current = false; }
  }

  async function chooseEverywhereItem(item: EverywhereItem) {
    if (item.type === 'symbol' && item.path.endsWith('.java')) {
      const sequence = ++symbolTargetSequence.current;
      const context = quickContextRef.current;
      const origin = activePathRef.current;
      const openedVersion = openRequestRef.current;
      const snapshot = fileStatesRef.current;
      const current = () => sequence === symbolTargetSequence.current && quickContextRef.current.quickOpen && quickContextRef.current.quickQuery === context.quickQuery && quickContextRef.current.projectId === context.projectId && activePathRef.current === origin && openRequestRef.current === openedVersion;
      setEverywhereNotice('正在确认代码位置…');
      try {
        const response = await fetch(`/api/local/projects/${project.id}/content?path=${encodeURIComponent(item.path)}`);
        const body = await response.json();
        if (!current()) return;
        if (response.status === 404) throw staleFastSymbol();
        if (!response.ok) throw new Error(body.message || '暂时无法读取目标文件');
        const cached = snapshot[item.path];
        const dirty = cached && cached.content !== cached.savedContent;
        const actual = dirty ? cached.content : body.content;
        await verifyFastSymbolTarget({ path: item.path, name: item.label, line: item.line, column: item.column, hash: item.hash || '', hashSource: item.hashSource || 'disk' }, actual);
        if (!current()) return;
        if (fileStatesRef.current !== snapshot) throw staleFastSymbol();
        if (!dirty) {
          const view: FileView = { kind: body.kind || 'text', mime: body.mime || 'text/plain', readOnly: !!body.readOnly, language: body.language, preview: body.preview, encoding: body.encoding, bom: body.bom };
          const next = { ...snapshot, [item.path]: { path: item.path, content: actual, savedContent: actual, version: body.version, view } };
          fileStatesRef.current = next; setFileStates(next);
          const model = monaco?.editor.getModel(monaco.Uri.parse(workspaceModelUri(project.id, item.path)));
          if (model && model.getValue() !== actual) model.setValue(actual);
          if (activePathRef.current === item.path) { setContent(actual); setSavedContent(actual); setFileVersion(body.version); setFileView(view); }
          setOpenFiles(files => files.includes(item.path) ? files : [...files, item.path]);
        }
        setQuickOpen(false); setEverywhereNotice('');
        await openFile(item.path, item.line, item.column);
      } catch (error: any) {
        if (!current()) return;
        if (error.code === 'FAST_SYMBOL_STALE') {
          setEverywhereNotice('代码已变化，正在更新搜索结果…');
          try {
            const response = await fetch(`/api/local/projects/${project.id}/language/index-refresh`, { method: 'POST' });
            if (!response.ok) throw new Error('refresh failed');
            if (current()) setEverywhereReload(value => value + 1);
          } catch { if (current()) setEverywhereNotice('代码已变化，请稍后重新搜索。'); }
        } else setEverywhereNotice(error.message || '暂时无法确认代码位置，请稍后重试。');
      }
      return;
    }
    setQuickOpen(false);
    if (item.type === "file") void openFile(item.path);
    else if (item.type === "text" || item.type === "symbol")
      void openFile(item.path, item.line, item.column);
    else if (item.type === "action") {
      if (item.action === "files" || item.action === "git")
        setSidebarMode(item.action);
      else if (item.action === "save") void save();
      else if (item.action === "refreshGit") {
        setSidebarMode("git");
        void loadGitStatus();
      }
    }
  }

  async function save() {
    if (!activePath || fileView.kind !== "text" || fileView.readOnly || saving) return;
    const path = activePath;
    const requestedContent = content;
    const commitBreakpointCheckpoint = javaRun.captureBreakpointCheckpoint.current(path);
    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        `/api/local/projects/${project.id}/content`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: activePath,
            content,
            expectedVersion: fileVersion,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message || `HTTP ${response.status}`);
      commitBreakpointCheckpoint();
      if (activePathRef.current === path) {
        setSavedContent(requestedContent);
        setFileVersion(body.version);
        setExternalChanged(false);
      }
      setFileStates((current) =>
        current[activePath]
          ? {
              ...current,
              [activePath]: {
                ...current[activePath],
                savedContent: requestedContent,
                version: body.version,
              },
            }
          : current,
      );
      if (sidebarMode === "git") void loadGitStatus();
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setSaving(false);
    }
  }

  async function saveAll() {
    const drafts = Object.values(fileStatesRef.current).filter((file) => !file.view.readOnly && file.content !== file.savedContent);
    const checkpoints = new Map(drafts.map(file => [file.path, javaRun.captureBreakpointCheckpoint.current(file.path)]));
    if (!drafts.length || saving) return;
    setSaving(true);
    setError('');
    let completed = 0;
    try {
      // Preflight the whole selection. Each PUT also checks its version to
      // protect against a disk write occurring after this check.
      for (const file of drafts) {
        const response = await fetch(`/api/local/projects/${project.id}/content?path=${encodeURIComponent(file.path)}`);
        if (!response.ok || (await response.json()).version !== file.version) throw new Error(`磁盘文件已变化，尚未保存任何文件：${file.path}`);
      }
      for (const file of drafts) {
        const response = await fetch(`/api/local/projects/${project.id}/content`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: file.path, content: file.content, expectedVersion: file.version }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(`${file.path}：${body.message || '保存失败'}`);
        checkpoints.get(file.path)?.();
        completed++;
        const latest = fileStatesRef.current[file.path];
        if (latest) {
          const next = { ...fileStatesRef.current, [file.path]: { ...latest, savedContent: file.content, version: body.version } };
          fileStatesRef.current = next;
          setFileStates(next);
          if (activePathRef.current === file.path) { setSavedContent(file.content); setFileVersion(body.version); }
        }
      }
      void loadGitStatus();
    } catch (reason: any) {
      setError(`${reason?.message || reason}${completed ? `；已保存 ${completed} 个文件，其余修改仍保留在草稿中` : ''}`);
    } finally { setSaving(false); }
  }

  async function loadGitStatus() {
    setGitLoading(true);
    try {
      const response = await fetch(
        `/api/local/projects/${project.id}/git/status`,
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message || `HTTP ${response.status}`);
      setGitStatus(body);
      if (body.repository) {
        const refsResponse = await fetch(
          `/api/local/projects/${project.id}/git/branches`,
        );
        const refsBody = await refsResponse.json();
        if (!refsResponse.ok)
          throw new Error(refsBody.message || `HTTP ${refsResponse.status}`);
        setGitRefs(refsBody);
        setGitRemote((current) =>
          refsBody.remotes.includes(current)
            ? current
            : refsBody.remotes[0] || "",
        );
      } else setGitRefs({ branches: [], remotes: [] });
      setGitSelection((current) => {
        const available = new Set<string>(
          body.files.map((file: GitFile) => file.path),
        );
        const kept = new Set(
          [...current].filter((item) => available.has(item)),
        );
        return kept;
      });
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setGitLoading(false);
    }
  }

  async function reloadWorkspaceFiles(refreshActive = true) {
    try {
      const response = await fetch(`/api/local/projects/${project.id}/files?refresh=true`);
      const body = await response.json();
      if (response.ok) setFiles(body.items);
      if (refreshActive && activePath) await openFile(activePath, undefined, undefined, false);
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    }
  }

  async function createWorkspaceEntry(parentPath: string, type: "file" | "directory") {
    const label = type === "file" ? "文件" : "文件夹";
    const name = await askPrompt({ title: `新增${label}`, message: `请输入${label}名称`, validate: value => value.trim() ? undefined : '名称不能为空' });
    if (!name?.trim()) return;
    const nextPath = [parentPath, name.trim()].filter(Boolean).join("/");
    try {
      const response = await fetch(`/api/local/projects/${project.id}/files`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: nextPath, type }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      await reloadWorkspaceFiles(false);
      if (type === "file") await openFile(body.path);
    } catch (reason: any) { setError(String(reason?.message || reason)); }
  }

  async function deleteWorkspaceEntry(path: string, isDir: boolean) {
    const affected = openFiles.filter((item) => item === path || item.startsWith(`${path}/`));
    const dirtyAffected = affected.some((item) => fileStates[item]?.content !== fileStates[item]?.savedContent);
    const warning = dirtyAffected ? "\n其中包含未保存的编辑，删除后无法恢复。" : "\n该操作无法撤销。";
    if (!window.confirm(`确定删除${isDir ? "文件夹" : "文件"}“${path}”吗？${warning}`)) return;
    try {
      const response = await fetch(`/api/local/projects/${project.id}/files?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      if (!response.ok) { const body = await response.json(); throw new Error(body.message || `HTTP ${response.status}`); }
      const remaining = openFiles.filter((item) => !affected.includes(item));
      setOpenFiles(remaining);
      setFileStates((current) => { const next = { ...current }; affected.forEach((item) => delete next[item]); return next; });
      if (activePath && affected.includes(activePath)) {
        setActivePath(undefined); setContent(""); setSavedContent(""); setFileVersion("");
        if (remaining.length) await openFile(remaining[remaining.length - 1], undefined, undefined, false);
      }
      await reloadWorkspaceFiles(false);
      void loadGitStatus();
    } catch (reason: any) { setError(String(reason?.message || reason)); }
  }

  async function moveWorkspaceEntry(from: string, isDir: boolean) {
    if (Object.values(fileStatesRef.current).some(file => file.content !== file.savedContent)) { setError('请先保存所有修改，再重命名或移动'); return; }
    const to = await askPrompt({ title: isDir ? '重命名 / 移动文件夹' : '重命名 / 移动文件', message: `当前位置：${from}。请输入新的项目相对路径；目标父文件夹需要已存在。此操作只移动文件，不自动修改 Java 包名或引用。`, initialValue: from, validate: value => value.trim() ? undefined : '路径不能为空' });
    if (!to?.trim() || to.trim() === from) return;
    setMovingFile(true);
    try {
      const body = await javaRun.moveWorkspaceEntry(from, to.trim());
      const remap = (path: string) => path === body.from ? body.to : path.startsWith(`${body.from}/`) ? body.to + path.slice(body.from.length) : path;
      const previous = fileStatesRef.current;
      const next: Record<string, OpenFileState> = {};
      for (const [path, state] of Object.entries(previous)) next[remap(path)] = { ...state, path: remap(path) };
      fileStatesRef.current = next; setFileStates(next);
      setOpenFiles(current => current.map(remap));
      const currentPath = activePathRef.current;
      const destination = currentPath ? remap(currentPath) : undefined;
      if (destination && destination !== currentPath) {
        activePathRef.current = destination; setActivePath(destination);
        if (monaco && next[destination]?.view.kind === 'text') {
          const uri = monaco.Uri.parse(workspaceModelUri(project.id, destination));
          const model = monaco.editor.getModel(uri) || monaco.editor.createModel(next[destination].content, monacoLang(destination), uri);
          const position = editorRef.current?.getPosition();
          editorRef.current?.setModel(model);
          if (position) editorRef.current?.setPosition(position);
        }
      }
      for (const model of monaco?.editor.getModels() || []) {
        const path = workspacePathFromUri(model.uri);
        if (model.uri.authority === project.id && path && remap(path) !== path) model.dispose();
      }
      navigationRef.current = navigationRef.current.map(entry => ({ ...entry, path: remap(entry.path) }));
      setNavigation(navigationRef.current);
      for (const [path, state] of [...viewStatesRef.current]) if (remap(path) !== path) { viewStatesRef.current.delete(path); viewStatesRef.current.set(remap(path), state); }
      await reloadWorkspaceFiles(false); void loadGitStatus();
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setMovingFile(false); }
  }

  async function showGitDiff(path: string) {
    setGitDiff({ path });
  }

  async function readGit(endpoint: string, params: Record<string, string>, signal?: AbortSignal) {
    const response = await fetch(`/api/local/projects/${project.id}/git/${endpoint}?${new URLSearchParams(params)}`, { signal });
    const body = await response.json(); if (!response.ok) throw new Error(body.message || 'Git 操作失败'); return body;
  }
  async function mutateGit(endpoint: string, input: any = {}) {
    if (Object.values(fileStatesRef.current).some(file => file.content !== file.savedContent && !file.view.readOnly)) throw new Error('请先保存或关闭未保存的编辑器草稿');
    const response = await fetch(`/api/local/projects/${project.id}/git/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const body = await response.json(); if (!response.ok) throw new Error(body.message || 'Git 操作失败'); return body;
  }
  async function startMerge() {
    if (!mergeBranch || !window.confirm(`将 ${mergeBranch} 合并到 ${gitStatus?.branch}？合并结果需要手动确认提交。`)) return;
    setGitLoading(true);
    try { const result = await mutateGit('merge', { branch: mergeBranch }); await loadGitStatus(); if (result.mergeInProgress) setShowGitResolver(true); }
    catch (reason: any) { setError(reason.message); } finally { setGitLoading(false); }
  }

  async function commitSelected() {
    const message = commitMessage.trim();
    if (!message || !gitSelection.size) return;
    if ([...gitSelection].some(path => { const file = fileStatesRef.current[path]; return file && !file.view.readOnly && file.content !== file.savedContent; })) { setError('所选文件包含未保存的修改，请先保存后再提交'); return; }
    setGitLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/local/projects/${project.id}/git/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, paths: [...gitSelection] }),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message || `HTTP ${response.status}`);
      setCommitMessage("");
      setGitStatus(body.status);
      setGitSelection(new Set());
      setGitDiff(undefined);
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setGitLoading(false);
    }
  }

  async function checkoutBranch(branch: string, create = false) {
    if (!branch || branch === gitStatus?.branch) return;
    if (Object.values(fileStatesRef.current).some(file => !file.view.readOnly && file.content !== file.savedContent)) { setError('请先保存编辑器中的修改，再切换分支'); return; }
    setGitLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/local/projects/${project.id}/git/checkout`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch, create }),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message || `HTTP ${response.status}`);
      setGitStatus(body.status);
      await refreshAfterGitChange();
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setGitLoading(false);
    }
  }

  async function createBranch() {
    const branch = await askPrompt({ title: '新建分支', message: '从当前版本创建并切换到新分支', placeholder: 'feature/my-change', confirmText: '创建分支', validate: value => value.trim() ? undefined : '分支名称不能为空' });
    if (branch?.trim()) await checkoutBranch(branch.trim(), true);
  }

  async function refreshAfterGitChange() {
    const previousPath = activePathRef.current;
    ++openRequestRef.current;
    fileStatesRef.current = {};
    setFileStates({});
    setActivePath(undefined);
    activePathRef.current = undefined;
    setContent(''); setSavedContent(''); setFileVersion('');
    setExternalChanged(false); setTarget(undefined); setGitDiff(undefined);
    setGitSelection(new Set());
    viewStatesRef.current.clear();
    commitHistory([], -1);
    const response = await fetch(`/api/local/projects/${project.id}/files?refresh=true`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    treeRevisionRef.current = body.revision;
    setFiles(body.items);
    const available = new Set<string>(body.items.filter((item: FileEntry) => item.type === 'file').map((item: FileEntry) => item.path));
    setOpenFiles(current => current.filter(path => available.has(path)));
    if (previousPath && available.has(previousPath)) await openFileRef.current(previousPath, undefined, undefined, false);
    await loadGitStatus();
  }
  refreshGitFilesRef.current = refreshAfterGitChange;

  async function syncGit(operation: "fetch" | "pull" | "push") {
    if (operation === 'pull' && Object.values(fileStatesRef.current).some(file => !file.view.readOnly && file.content !== file.savedContent)) { setError('请先保存编辑器中的修改，再拉取更新'); return; }
    if (
      operation === "push" &&
      !(await askConfirm(`确定将 ${gitStatus?.branch || "当前分支"} 推送到 ${gitRemote || "上游"} 吗？`))
    )
      return;
    setGitLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/local/projects/${project.id}/git/sync`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation, remote: gitRemote || undefined }),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message || `HTTP ${response.status}`);
      setGitStatus(body.status);
      if (operation === 'pull') await refreshAfterGitChange();
      else await loadGitStatus();
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setGitLoading(false);
    }
  }

  const nativeBlameUnsupported = fileView.encoding?.startsWith('utf-16');
  const blame = useGitBlame(project.id, nativeBlameUnsupported ? undefined : activePath, content, async (path, content, signal) => {
    const response = await fetch(`/api/local/projects/${project.id}/git/blame`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content }), signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || '无法加载行注释');
    return body;
  }, appearanceOptions.lineNumbers === 'on');
  const title = useMemo(
    () => (activePath ? activePath.split("/").pop() : "选择文件"),
    [activePath],
  );
  const treeActionsRef = useRef({ createWorkspaceEntry, deleteWorkspaceEntry, moveWorkspaceEntry });
  treeActionsRef.current = { createWorkspaceEntry, deleteWorkspaceEntry, moveWorkspaceEntry };
  const treeActions = useMemo(() => ({
    onSelect: (path: string) => { void openFileRef.current(path); },
    onCreate: (parentPath: string, type: 'file' | 'directory') => { void treeActionsRef.current.createWorkspaceEntry(parentPath, type); },
    onDelete: (path: string, isDir: boolean) => { void treeActionsRef.current.deleteWorkspaceEntry(path, isDir); },
    onMove: (path: string, isDir: boolean) => { void treeActionsRef.current.moveWorkspaceEntry(path, isDir); },
  }), []);
  function mountEditor(instance: any, monacoInstance: any) {
    installWorkspaceRelations(instance, monacoInstance, {
      request: async input => {
        const documents = Object.entries(fileStatesRef.current).filter(([path, file]) => /\.(java|xml)$/.test(path) && path !== input.path && file.content !== file.savedContent).map(([path, file]) => ({ path, content: file.content }));
        const response = await fetch(`/api/local/projects/${project.id}/language/related-locations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, documents }) });
        if (!response.ok) throw Error('文件关联查询暂不可用'); return response.json();
      },
      open: (path, line, column) => openFileRef.current(path, line, column),
    });
    blame.attach(instance);
    editorRef.current = instance;
    instance.addCommand(monacoInstance.KeyMod.Shift | monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.KeyF, () => void formatActiveRef.current());
    setEditor(instance);
    setMonaco(monacoInstance);
    const cursorListener = instance.onDidChangeCursorPosition((event: any) => {
      if (movingHistoryRef.current || !['mouse', 'keyboard'].includes(event.source)) return;
      clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = setTimeout(() => {
        const destination = currentCursor();
        if (destination) recordNavigation(cursorCheckpointRef.current, destination);
      }, 350);
    });
    instance.onDidDispose(() => { cursorListener.dispose(); clearTimeout(cursorTimerRef.current); });
    const navigateToDefinition = async (currentEditor: any, requestedPosition?: any) => {
      try {
        const model = currentEditor.getModel();
        const position = requestedPosition || currentEditor.getPosition();
        if (!model || !position) return;
        const version = model.getVersionId();
        setError("");
        let definition: any;
        const sourcePath = workspacePathFromUri(model.uri);
        if (sourcePath) {
          const response = await fetch(
            `/api/local/projects/${project.id}/language/definition`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                path: sourcePath,
                content: model.getValue(),
                line: position.lineNumber,
                column: position.column,
                documents: dirtyDocuments(sourcePath),
              }),
            },
          );
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            if (!isLanguageStartupError(body)) setError(body.message || `代码跳转失败（HTTP ${response.status}）`);
            return;
          }
          const result = (await response.json()).result;
          if (model.isDisposed() || model.getVersionId() !== version || currentEditor.getModel() !== model) return;
          const results = Array.isArray(result) ? result : result ? [result] : [];
          const preferred = results.find((item: any) => item.path && item.path !== sourcePath) || results[0];
          const preferredRange = preferred?.range || preferred?.targetSelectionRange || preferred?.targetRange;
          if (preferred?.path && preferredRange)
            definition = {
              uri: monacoInstance.Uri.parse(workspaceModelUri(project.id, preferred.path)),
              range: new monacoInstance.Range(
                preferredRange.start.line + 1,
                preferredRange.start.character + 1,
                preferredRange.end.line + 1,
                preferredRange.end.character + 1,
              ),
            };
        }
        if (!definition) {
          setError("未找到该符号的定义。请确认光标位于可跳转的符号上。");
          return;
        }
        const targetPath = workspacePathFromUri(definition.uri);
        if (!targetPath) {
          setError("目标定义不在当前项目中，暂时无法打开。");
          return;
        }
        const targetPosition = { lineNumber: definition.range.startLineNumber, column: definition.range.startColumn };
        await openFileRef.current(targetPath, targetPosition.lineNumber, targetPosition.column);
      } catch (reason: any) {
        setError(`代码跳转失败：${String(reason?.message || reason)}`);
      }
      };
    instance.onMouseDown((event: any) => {
      if (event.target?.type === monacoInstance.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position) {
        const file = workspacePathFromUri(instance.getModel()?.uri);
        if (file?.endsWith(".java") && !file.startsWith("@java-source/")) {
          if (event.event?.browserEvent?.button === 2) { event.event.browserEvent.preventDefault(); javaRun.editBreakpoint.current(file, event.target.position.lineNumber); }
          else if (event.event?.browserEvent?.button === 0) javaRun.toggleBreakpoint.current(file, event.target.position.lineNumber);
        }
        return;
      }
      const browserEvent = event.event?.browserEvent;
      if (!(browserEvent?.metaKey || browserEvent?.ctrlKey) || !event.target?.position) return;
      browserEvent.preventDefault();
      browserEvent.stopPropagation();
      void navigateToDefinition(instance, event.target.position);
    });
    instance.addAction({
      id: 'desktop-toggle-breakpoint', label: '切换断点', keybindings: [monacoInstance.KeyCode.F9], contextMenuGroupId: 'navigation', contextMenuOrder: 8,
      run: (current: any) => { const file = workspacePathFromUri(current.getModel()?.uri), line = current.getPosition()?.lineNumber; if (file?.endsWith('.java') && !file.startsWith('@java-source/') && line) javaRun.toggleBreakpoint.current(file, line); },
    });
    instance.addAction({
      id: "desktop-open-definition",
      label: "转到定义",
      keybindings: [monacoInstance.KeyCode.F12],
      run: navigateToDefinition,
    });
    instance.addAction({
      id: 'desktop-open-implementation', label: '转到实现',
      keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.F12],
      run: (current: any) => current.trigger('desktop', 'editor.action.goToImplementation', null),
    });
  }
  return (
    <div className="h-full bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <PanelGroup
        direction="horizontal"
        className="workspace-frame h-full"
        autoSaveId="desktop-ws-h"
      >
        <WorkspaceChatPanel>
          <div className="flex h-full min-h-0 flex-col bg-slate-50/70 dark:bg-slate-900/40">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 px-3 text-[11px] font-semibold dark:border-slate-800">
              <Bot size={13} className="text-indigo-500" />
              智能助手
            </div>
            <DesktopLocalAgentPanel projectId={project.id} onFilesChanged={() => { void reloadWorkspaceFiles(); void loadGitStatus(); }} />
          </div>
        </WorkspaceChatPanel>
        <Panel id="workspace-content" order={2} minSize={30}>
          <section className="flex h-full min-w-0 flex-col bg-white dark:bg-slate-900">
            <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
              <button
                type="button"
                className="icon-btn"
                onClick={onBack}
                title="返回最近项目"
              >
                <ArrowLeft size={17} />
              </button>
              <ChatVisibilityButton />
              <EditorAppearanceSettings />
              <div className="flex items-center">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={navigationIndex <= 0}
                  onClick={() => void moveInHistory(-1)}
                  title={`返回上一处光标位置（${shortcuts[0]}）`}
                  aria-label="返回上一处光标位置"
                >
                  <ArrowLeft size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={
                    navigationIndex < 0 ||
                    navigationIndex >= navigation.length - 1
                  }
                  onClick={() => void moveInHistory(1)}
                  title={`前进到下一处光标位置（${shortcuts[1]}）`}
                  aria-label="前进到下一处光标位置"
                >
                  <ArrowRight size={15} />
                </button>
              </div>
              <Select size="sm" ariaLabel="光标导航快捷键方案" title={`后退 ${shortcuts[0]} · 前进 ${shortcuts[1]}`} value={navigationKeymap}
                options={[{ value: 'idea', label: 'IDEA 快捷键' }, { value: 'vscode', label: 'VS Code 快捷键' }, { value: 'eclipse', label: 'Eclipse 快捷键' }]}
                onChange={(value) => setNavigationKeymap(value as 'idea' | 'vscode' | 'eclipse')} />
              <div className="min-w-0">
                <div className="truncate text-xs font-bold">{project.name}</div>
                <div className="max-w-48 truncate text-[9px] text-slate-400">
                  {project.path}
                </div>
              </div>
              <div className="flex items-center gap-1 rounded-xl bg-slate-100/90 p-1 dark:bg-slate-950/60">
                <WorkspaceTab
                  active={workspaceTab === "code"}
                  onClick={() => { setWorkspaceTab("code"); setSidebarMode("files"); }}
                >
                  <CodeXml size={14} />
                  代码
                </WorkspaceTab>
                <WorkspaceTab
                  active={workspaceTab === "preview"}
                  onClick={() => setWorkspaceTab("preview")}
                >
                  <Eye size={14} />
                  预览
                </WorkspaceTab>
                <WorkspaceTab
                  active={workspaceTab === "history"}
                  onClick={() => {
                    setWorkspaceTab("history");
                    setSidebarMode("git");
                  }}
                >
                  <History size={14} />
                  历史
                </WorkspaceTab>
                <WorkspaceTab active={workspaceTab === 'rest'} onClick={() => { setRestOpened(true); setWorkspaceTab('rest'); }}>API 调试</WorkspaceTab>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {workspaceTab === 'code' && javaRun.toolbar}
                {workspaceTab === 'code' && <button className="btn btn-ghost btn-sm" title="格式化（Shift+Alt+F）" aria-label="格式化当前文件" disabled={!activePath || !canFormatDocument(activePath) || fileView.readOnly || formatting} onClick={() => void formatActiveFile()}>{formatting ? '格式化…' : '格式化'}</button>}
                <GitBlameDetails item={blame.selected} onClose={blame.close} load={async (hash, signal) => { const response = await fetch(`/api/local/projects/${project.id}/git/commits/${hash}/diff`, { signal }); const body = await response.json(); if (!response.ok) throw new Error(body.message || '无法加载提交改动'); return body; }} />
                {workspaceTab === 'code' && <button className="btn btn-ghost btn-sm" disabled={nativeBlameUnsupported} title={nativeBlameUnsupported ? 'UTF-16 文件暂不支持 Git 行注释' : undefined} aria-pressed={blame.enabled} onClick={blame.toggle}>行注释</button>}
                {workspaceTab === 'code' && blame.status && <span role="status" className="max-w-48 truncate text-[10px] text-muted" title={blame.status}>{blame.status}</span>}
                <span className="max-w-24 truncate text-xs text-slate-400" title={title}>
                  {title}
                  {dirty ? " • 未保存" : ""}
                </span>
                {workspaceTab === "code" && (
                  <button
                    type="button"
                    className={`icon-btn ${terminalOpen ? "text-indigo-500" : ""}`}
                    onClick={() => setTerminalOpen((value) => !value)}
                    title="终端"
                  >
                    <SquareTerminal size={16} />
                  </button>
                )}
                <button type="button" className="btn btn-sm" disabled={saving || !Object.values(fileStates).some((file) => !file.view.readOnly && file.content !== file.savedContent)} onClick={() => void saveAll()}>
                  全部保存
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={
                    fileView.kind !== "text" ||
                    !dirty ||
                    saving ||
                    externalChanged
                  }
                  onClick={() => void save()}
                >
                  {saving ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : (
                    <Save size={13} />
                  )}
                  保存
                </button>
              </div>
            </header>
            {quickOpen && (
              <div
                className="fixed inset-0 z-50 flex justify-center bg-slate-950/35 px-4 pt-[12vh] backdrop-blur-[1px]"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) setQuickOpen(false);
                }}
              >
                <div className="flex max-h-[62vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
                  <div className="flex items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-700">
                    <Search size={16} className="text-slate-400" />
                    <input
                      autoFocus
                      value={quickQuery}
                      onChange={(event) => {
                        setQuickQuery(event.target.value);
                        setQuickSelection(0);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          setQuickSelection((value) =>
                            Math.min(value + 1, everywhereItems.length - 1),
                          );
                        }
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          setQuickSelection((value) => Math.max(value - 1, 0));
                        }
                        if (
                          event.key === "Enter" &&
                          everywhereItems[quickSelection]
                        )
                          chooseEverywhereItem(everywhereItems[quickSelection]);
                      }}
                      placeholder="文件名；@ 符号；# 全文；> 动作"
                      className="min-w-0 flex-1 bg-transparent py-4 text-sm outline-none"
                    />
                    <kbd className="rounded border px-1.5 py-0.5 text-[10px] text-slate-400">
                      Esc
                    </kbd>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setQuickOpen(false)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {everywhereNotice && <p role="status" className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">{everywhereNotice}</p>}
                  <div className="min-h-0 overflow-auto py-1">
                    {everywhereLoading ? (
                      <div className="flex items-center justify-center gap-2 px-4 py-8 text-xs text-slate-400">
                        <LoaderCircle size={14} className="animate-spin" />
                        搜索中…
                      </div>
                    ) : everywhereItems.length ? (
                      everywhereItems.map((item, index) => (
                        <button
                          key={`${item.type}:${item.detail}:${index}`}
                          type="button"
                          onMouseEnter={() => setQuickSelection(index)}
                          onClick={() => chooseEverywhereItem(item)}
                          className={`flex w-full items-center gap-2 px-4 py-2 text-left text-xs ${index === quickSelection ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200" : ""}`}
                        >
                          {item.type === "action" ? (
                            <span className="w-4 text-center font-mono text-indigo-500">
                              ›
                            </span>
                          ) : item.type === "symbol" ? (
                            <span className="w-4 text-center font-mono text-violet-500">
                              @
                            </span>
                          ) : item.type === "text" ? (
                            <Search size={13} />
                          ) : (
                            <File size={13} />
                          )}
                          <span className="truncate font-medium">
                            {item.label}
                          </span>
                          <span className="ml-auto max-w-[62%] truncate text-[10px] text-slate-400">
                            {item.detail}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="px-4 py-8 text-center text-xs text-slate-400">
                        没有匹配结果
                      </div>
                    )}
                  </div>
                  <div className="border-t border-slate-200 px-4 py-2 text-[10px] text-slate-400 dark:border-slate-700">
                    Cmd/Ctrl+P 文件 · @ 符号 · # 全文 · &gt; 动作 · ↑↓ 选择 ·
                    Enter 打开
                  </div>
                </div>
              </div>
            )}
            {showGitCompare && <GitCompareModal scope={`local:${project.id}`} current={gitStatus?.branch || 'HEAD'} branches={gitRefs.branches} load={(params, signal) => readGit('compare', params, signal)} onClose={() => setShowGitCompare(false)} />}
            {showGitResolver && <ConflictResolverModal conflicts={gitStatus?.conflicts || []} onClose={() => setShowGitResolver(false)} transport={{ scope: `local:${project.id}`, detail: path => readGit('conflicts/detail', { path }), resolve: body => mutateGit('conflicts/resolve', body), continue: () => mutateGit('conflicts/continue'), abort: () => mutateGit('conflicts/abort'), changed: () => { void refreshAfterGitChange().catch(reason => setError(reason.message)); } }} />}
            {gitDiff && <WorkingDiffModal scope={`local:${project.id}`} path={gitDiff.path} load={(params, signal) => readGit('working-diff', params, signal)} onClose={() => setGitDiff(undefined)} onApply={async (value, baseline) => {
              const file = gitDiff.path;
              const current = fileStatesRef.current[file];
              if (current && current.content !== current.savedContent) throw new Error('文件有未保存草稿，请先保存或撤销');
              const disk = await readGit('working-diff', { path: file, stage: 'working' });
              if (disk.after !== baseline || !disk.exists) throw new Error('文件已变化，请重新打开对比');
              await openFile(file);
              const state = fileStatesRef.current[file]; if (!state || state.view.readOnly) throw new Error('无法编辑此文件');
              if (state.content !== baseline) throw new Error('文件内容已更新，请重新打开对比');
              const next = { ...fileStatesRef.current, [file]: { ...state, content: value } }; fileStatesRef.current = next; setFileStates(next); setContent(value); setWorkspaceTab('code');
              const model = monaco?.editor.getModel(monaco.Uri.parse(workspaceModelUri(project.id, file))); model?.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
            }} />}
            {indexTruncated && (
              <div className="flex items-center border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                大型项目的后台代码索引已按资源上限加载；未索引文件仍可从文件树打开并使用代码导航。
                <button type="button" className="ml-auto px-2" onClick={() => setIndexTruncated(false)}>×</button>
              </div>
            )}
            {error && (
              <div className="flex items-center border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                <span className="min-w-0 flex-1">{error}</span>
                {externalChanged && activePath && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm ml-3"
                    onClick={() => void openFile(activePath)}
                  >
                    重新加载磁盘版本
                  </button>
                )}
              </div>
            )}
            <div
              className={
                workspaceTab === "code"
                  ? "min-h-0 flex-1"
                  : "hidden min-h-0 flex-1"
              }
            >
              <PanelGroup
                direction="horizontal"
                className="h-full"
                autoSaveId="desktop-ws-code"
              >
                <Panel defaultSize={22} minSize={12} maxSize={40}>
                  <div className="flex h-full min-w-0">
                    <aside className="flex h-full w-full min-w-0 flex-col border-r border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/40">
                      <div className="flex h-10 shrink-0 items-center border-b border-slate-200 px-3 text-[11px] font-bold dark:border-slate-800">
                        <button className={`mr-4 ${sidebarMode === 'files' ? 'text-indigo-500' : 'text-slate-400'}`} onClick={() => setSidebarMode('files')}>资源管理器</button>
                        <button className={sidebarMode === 'git' ? 'text-indigo-500' : 'text-slate-400'} onClick={() => setSidebarMode('git')}>分支 / 变更{gitStatus?.files.length ? ` · ${gitStatus.files.length}` : ''}</button>
                      </div>
                      {sidebarMode === "files" ? (
                        <>
                          <div className="border-b border-slate-200 p-2 dark:border-slate-800">
                            <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2 dark:border-slate-700 dark:bg-slate-900">
                              <Search size={13} className="text-slate-400" />
                              <input
                                value={searchInput}
                                onChange={(event) =>
                                  setSearchInput(event.target.value)
                                }
                                placeholder="全局搜索"
                                className="min-w-0 flex-1 bg-transparent py-2 text-xs outline-none"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setCaseSensitive((value) => !value)
                                }
                                className={`rounded p-1 ${caseSensitive ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20" : "text-slate-400"}`}
                                title="区分大小写"
                              >
                                <CaseSensitive size={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => setRegex((value) => !value)}
                                className={`rounded p-1 ${regex ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20" : "text-slate-400"}`}
                                title="正则表达式"
                              >
                                <Regex size={13} />
                              </button>
                            </div>
                            {searchInput && (
                              <input
                                value={glob}
                                onChange={(event) =>
                                  setGlob(event.target.value)
                                }
                                placeholder="文件过滤，例如 **/*.ts"
                                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] outline-none dark:border-slate-700 dark:bg-slate-900"
                              />
                            )}
                          </div>
                          <div className="min-h-0 flex-1 overflow-auto py-2">
                            {searchInput.trim() ? (
                              searching ? (
                                <div className="flex items-center gap-2 px-4 py-3 text-xs text-slate-400">
                                  <LoaderCircle
                                    size={14}
                                    className="animate-spin"
                                  />
                                  搜索中…
                                </div>
                              ) : searchResults.length ? (
                                searchResults.map((result, index) => (
                                  <button
                                    key={`${result.path}:${result.line}:${result.column}:${index}`}
                                    type="button"
                                    onClick={() =>
                                      void openFile(
                                        result.path,
                                        result.line,
                                        result.column,
                                      )
                                    }
                                    className="block w-full border-b border-slate-200/70 px-3 py-2 text-left hover:bg-indigo-50 dark:border-slate-800 dark:hover:bg-indigo-500/10"
                                  >
                                    <span className="block truncate text-[11px] font-semibold">
                                      {result.path}:{result.line}:
                                      {result.column}
                                    </span>
                                    <span className="mt-1 block truncate font-mono text-[10px] text-slate-500">
                                      {result.preview}
                                    </span>
                                  </button>
                                ))
                              ) : (
                                <div className="px-4 py-3 text-xs text-slate-400">
                                  没有匹配结果
                                </div>
                              )
                            ) : loadingTree ? (
                              <div className="flex items-center gap-2 px-4 py-3 text-xs text-slate-400">
                                <LoaderCircle
                                  size={14}
                                  className="animate-spin"
                                />
                                读取文件…
                              </div>
                            ) : (
                              <LocalFileTree
                                active={active}
                                projectName={project.name}
                                entries={files}
                                selected={activePath}
                                {...treeActions}
                              />
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2 border-t border-slate-200 px-3 py-2 dark:border-slate-800">
                            <GitBranch size={13} className="text-slate-400" />
                            {gitStatus?.repository ? <Select ariaLabel="当前分支" searchable searchPlaceholder="搜索分支" menuMinWidth={320} className="min-w-0 flex-1" buttonClassName="border-0 bg-transparent shadow-none" size="sm" value={gitStatus.branch || ""} disabled={gitLoading} onChange={(branch) => void checkoutBranch(branch)} options={gitRefs.branches.map((branch) => ({ value: branch, label: branch }))} /> : <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">非 Git 仓库</span>}
                            {gitStatus?.files.length ? <button type="button" className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" onClick={() => { setWorkspaceTab("code"); setSidebarMode("git"); }}>{gitStatus.files.length} 项变更</button> : null}
                          </div>
                        </>
                      ) : (
                        <div className="flex min-h-0 flex-1 flex-col">
                          <div className="flex items-center border-b border-slate-200 px-3 py-2 dark:border-slate-800">
                            <GitBranch size={13} />
                            <span className="ml-2 min-w-0 flex-1 truncate text-xs font-semibold">
                              {gitStatus?.repository
                                ? gitStatus.branch
                                : "非 Git 仓库"}
                            </span>
                            {gitStatus?.ahead ? (
                              <span className="mr-2 text-[10px] text-emerald-500">
                                ↑{gitStatus.ahead}
                              </span>
                            ) : null}
                            {gitStatus?.behind ? (
                              <span className="mr-2 text-[10px] text-amber-500">
                                ↓{gitStatus.behind}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => void loadGitStatus()}
                              title="刷新 Git 状态"
                              disabled={gitLoading}
                            >
                              <RefreshCw
                                size={13}
                                className={gitLoading ? "animate-spin" : ""}
                              />
                            </button>
                          </div>
                          {gitStatus?.repository ? (
                            <>
                              <div className="space-y-2 border-b border-slate-200 p-2 dark:border-slate-800">
                                <div className="flex gap-1">
                                  <button className="btn btn-secondary btn-sm flex-1" onClick={() => setShowGitCompare(true)}>对比分支</button>
                                  {gitStatus.mergeInProgress || gitStatus.conflicts?.length ? <button className="btn btn-secondary btn-sm flex-1" onClick={() => setShowGitResolver(true)}>解决冲突 / 完成合并</button> : null}
                                </div>
                                {!gitStatus.mergeInProgress && <div className="flex gap-1"><Select ariaLabel="待合并分支" searchable searchPlaceholder="搜索待合并分支" className="min-w-0 flex-1" size="sm" value={mergeBranch} onChange={setMergeBranch} options={[{value:'',label:'选择合并来源'}, ...gitRefs.branches.filter(branch => branch !== gitStatus.branch).map(branch => ({value:branch,label:branch}))]} /><button className="btn btn-secondary btn-sm" disabled={!mergeBranch || gitLoading} onClick={() => void startMerge()}>合并</button></div>}
                                <div className="flex gap-1">
                                  <Select
                                    ariaLabel="当前分支"
                                    className="min-w-0 flex-1"
                                    size="sm"
                                    value={gitStatus.branch || ""}
                                    searchable searchPlaceholder="搜索分支" menuMinWidth={320}
                                    disabled={gitLoading}
                                    onChange={(branch) => void checkoutBranch(branch)}
                                    options={gitRefs.branches.map((branch) => ({ value: branch, label: branch }))}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => void createBranch()}
                                    disabled={gitLoading}
                                    title="创建分支"
                                  >
                                    ＋
                                  </button>
                                </div>
                                <div className="flex gap-1">
                                  <Select
                                    ariaLabel="远程仓库"
                                    className="min-w-0 flex-1"
                                    size="sm"
                                    value={gitRemote}
                                    onChange={setGitRemote}
                                    options={[{ value: "", label: "无远程" }, ...gitRefs.remotes.map((remote) => ({ value: remote, label: remote }))]}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm px-2 text-[10px]"
                                    disabled={
                                      gitLoading || !gitRefs.remotes.length
                                    }
                                    onClick={() => void syncGit("fetch")}
                                  >
                                    Fetch
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm px-2 text-[10px]"
                                    disabled={
                                      gitLoading || !gitRefs.remotes.length
                                    }
                                    onClick={() => void syncGit("pull")}
                                  >
                                    Pull
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm px-2 text-[10px]"
                                    disabled={
                                      gitLoading || !gitRefs.remotes.length
                                    }
                                    onClick={() => void syncGit("push")}
                                  >
                                    Push
                                  </button>
                                </div>
                              </div>
                              <div className="min-h-0 flex-1 overflow-auto py-1">
                                {!!gitStatus.files.length && <label className="flex items-center gap-2 px-3 py-2 text-[11px] text-slate-500"><input type="checkbox" aria-label="选择全部变更" checked={gitSelection.size === gitStatus.files.length} onChange={event => setGitSelection(event.target.checked ? new Set(gitStatus.files.map(file => file.path)) : new Set())} />选择全部变更</label>}
                                {gitStatus.files.length ? (
                                  gitStatus.files.map((file) => (
                                    <div
                                      key={file.path}
                                      className="group flex items-center gap-2 px-3 py-1.5 hover:bg-indigo-50 dark:hover:bg-indigo-500/10"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={gitSelection.has(file.path)}
                                        onChange={() =>
                                          setGitSelection((current) => {
                                            const next = new Set(current);
                                            if (next.has(file.path))
                                              next.delete(file.path);
                                            else next.add(file.path);
                                            return next;
                                          })
                                        }
                                      />
                                      <button
                                        type="button"
                                        className="min-w-0 flex-1 truncate text-left text-[11px]"
                                        onClick={() => { setWorkspaceTab("code"); void openFile(file.path); }}
                                        title={file.path}
                                      >
                                        {file.path}
                                      </button>
                                      <button type="button" className="icon-btn h-6 w-6 opacity-0 group-hover:opacity-100" onClick={() => void showGitDiff(file.path)} title="查看差异"><Eye size={12} /></button>
                                      <span className="font-mono text-[10px] font-bold text-amber-500">
                                        {file.indexStatus}
                                        {file.worktreeStatus}
                                      </span>
                                    </div>
                                  ))
                                ) : (
                                  <div className="px-4 py-8 text-center text-xs text-slate-400">
                                    工作区没有变更
                                  </div>
                                )}
                              </div>
                              <div className="border-t border-slate-200 p-2 dark:border-slate-800">
                                <textarea
                                  value={commitMessage}
                                  onChange={(event) =>
                                    setCommitMessage(event.target.value)
                                  }
                                  maxLength={500}
                                  rows={3}
                                  placeholder="提交信息"
                                  className="input w-full resize-none text-xs"
                                />
                                <button
                                  type="button"
                                  className="btn btn-primary mt-2 w-full"
                                  disabled={
                                    gitLoading ||
                                    !commitMessage.trim() ||
                                    !gitSelection.size
                                  }
                                  onClick={() => void commitSelected()}
                                >
                                  {gitLoading ? (
                                    <LoaderCircle
                                      size={13}
                                      className="animate-spin"
                                    />
                                  ) : (
                                    <GitBranch size={13} />
                                  )}
                                  提交{" "}
                                  {gitSelection.size
                                    ? `${gitSelection.size} 个文件`
                                    : ""}
                                </button>
                              </div>
                            </>
                          ) : (
                            <div className="px-4 py-8 text-center text-xs text-slate-400">
                              该目录尚未初始化 Git 仓库
                            </div>
                          )}
                        </div>
                      )}
                    </aside>
                  </div>
                </Panel>
                <PanelResizeHandle className="resize-handle-x" />
                <Panel minSize={30}>
                  <section className="flex h-full min-w-0 flex-1 flex-col bg-white dark:bg-slate-950">
                    {openFiles.length > 0 && (
                      <div className="flex h-9 shrink-0 overflow-x-auto border-b border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-900/70">
                        {openFiles.map((path) => {
                          const state = fileStates[path];
                          const changed = state
                            ? state.content !== state.savedContent
                            : false;
                          return (
                            <button
                              key={path}
                              type="button"
                              onClick={() =>
                                void openFile(path, undefined, undefined, false)
                              }
                              className={`group flex max-w-56 shrink-0 items-center gap-2 border-r border-slate-200 px-3 text-[10px] dark:border-slate-800 ${activePath === path ? "bg-white font-semibold text-indigo-700 dark:bg-slate-950 dark:text-indigo-300" : "text-slate-500 hover:bg-white/70 dark:hover:bg-slate-800"}`}
                              title={path}
                            >
                              <WorkspaceFileIcon path={path} size={13} />
                              <span className="truncate">
                                {path.split("/").pop()}
                              </span>
                              {changed && (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />
                              )}
                              <span
                                role="button"
                                aria-disabled={saving || movingFile}
                                tabIndex={saving || movingFile ? -1 : 0}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void closeFile(path);
                                }}
                                className="ml-auto rounded p-0.5 opacity-0 hover:bg-slate-200 group-hover:opacity-100 dark:hover:bg-slate-700"
                              >
                                <X size={11} />
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <PanelGroup direction="vertical">
                    <Panel id="workspace-editor" order={1} minSize={15}>
                    <div className="h-full min-h-0">
                      {activePath && monacoLang(activePath) === 'sql' && <WorkspaceSqlBinding key={project.id} scope={workspaceSqlScope('local', project.id)} projectId={project.id} content={content} local active={active} />}
                      {loadingFile ? (
                        <div className="grid h-full place-items-center text-sm text-slate-400">
                          <LoaderCircle size={20} className="animate-spin" />
                        </div>
                      ) : activePath ? (
                        <LocalFileViewer
                          projectId={project.id}
                          path={activePath}
                          view={fileView}
                          content={content}
                          onMarkdownNavigate={navigateMarkdown}
                          markdownAnchor={markdownTarget?.path === activePath ? markdownTarget.anchor : undefined}
                          onMarkdownAnchorApplied={markdownAnchorApplied}
                        >
                          {fileView.kind === "text" ? (
                            <Editor
                              keepCurrentModel
                              saveViewState
                              path={workspaceModelUri(project.id, activePath)}
                              language={fileView.language || monacoLang(activePath)}
                              value={content}
                              theme={editorTheme}
                              onMount={mountEditor}
                              onChange={(value) => {
                                const next = value ?? "";
                                setContent(next);
                                const path = activePathRef.current;
                                if (path)
                                  setFileStates((current) =>
                                    current[path]
                                      ? {
                                          ...current,
                                          [path]: {
                                            ...current[path],
                                            content: next,
                                          },
                                        }
                                      : current,
                                  );
                              }}
                              beforeMount={setupIntelliSense}
                              options={{
                                readOnly: Boolean(fileView.readOnly) || movingFile,
                                glyphMargin: activePath.endsWith(".java") && !fileView.readOnly,
                                automaticLayout: true,
                                ...(blame.enabled ? baseAppearanceOptions : appearanceOptions),
                                scrollBeyondLastLine: false,
                              }}
                            />
                          ) : null}
                        </LocalFileViewer>
                      ) : (
                        <div className="grid h-full place-items-center text-sm text-slate-400">
                          从左侧选择一个文件
                        </div>
                      )}
                    </div>
                    </Panel>
                    {workspaceTab === "code" && javaRun.panel && <>
                      <PanelResizeHandle className="resize-handle-y" aria-label="调整运行面板高度" />
                      <Panel id="java-run-output" order={2} defaultSize={runPanelSize.current} minSize={15} maxSize={80} onResize={size => { if (size > 0) runPanelSize.current = size; }}>{javaRun.panel}</Panel>
                    </>}
                    {workspaceTab === "code" && terminalOpen && (
                      <>
                      <PanelResizeHandle className="resize-handle-y" aria-label="调整终端面板高度" />
                      <Panel id="terminal-output" order={3} defaultSize={34} minSize={15} maxSize={80}>
                      <div className="relative h-full min-h-0 border-t border-slate-700">
                        <DesktopLocalOutputPanel
                          projectId={project.id}
                          onClose={() => setTerminalOpen(false)}
                        />
                      </div>
                      </Panel>
                      </>
                    )}
                    </PanelGroup>
                  </section>
                </Panel>
              </PanelGroup>
            </div>
            <div
              className={
                workspaceTab === "preview"
                  ? "min-h-0 flex-1"
                  : "hidden min-h-0 flex-1"
              }
            >
              <DesktopLocalPreview projectId={project.id} />
            </div>
            {workspaceTab === 'history' && <div className="min-h-0 flex-1"><HistoryPanel transport={historyTransport} /></div>}
            {restOpened && <div className={workspaceTab === 'rest' ? 'min-h-0 flex-1' : 'hidden min-h-0 flex-1'}><DesktopRestClient projectId={project.id} /></div>}
            <DesktopLanguageStatus projectId={project.id} active={active} includeFastIndex={!!activePath && monacoLang(activePath) === 'java'} />
          </section>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function LocalFileViewer({ projectId, path, view, children, content, onMarkdownNavigate, markdownAnchor, onMarkdownAnchorApplied }: { projectId: string; path: string; view: FileView; children: React.ReactNode; content: string; onMarkdownNavigate: (target: MarkdownNavigation) => void; markdownAnchor?: string; onMarkdownAnchorApplied: () => void }) {
  const loadMarkdownImage = useCallback(async (resource: string, signal: AbortSignal) => {
    const response = await fetch(`/api/local/projects/${projectId}/file-preview?path=${encodeURIComponent(resource)}`, { signal });
    if (!response.ok) throw new Error('图片不可用'); return response.blob();
  }, [projectId]);
  return <WorkspaceFileViewer path={path} view={view} content={content} loadMarkdownImage={loadMarkdownImage} onMarkdownNavigate={onMarkdownNavigate} markdownAnchor={markdownAnchor} onMarkdownAnchorApplied={onMarkdownAnchorApplied} rawUrl={`/api/local/projects/${projectId}/file-preview?path=${encodeURIComponent(path)}`}>{children}</WorkspaceFileViewer>;
}

function WorkspaceTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${active ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-indigo-300 dark:ring-slate-700" : "text-slate-500 hover:bg-white/70 dark:text-slate-400 dark:hover:bg-slate-800/60"}`}
    >
      {children}
    </button>
  );
}

function buildLocalTree(entries: FileEntry[]): LocalTreeNode[] {
  return buildWorkspaceFileTree(entries);
}

const LocalFileTree = memo(function LocalFileTree({
  active,
  projectName,
  entries,
  selected,
  onSelect,
  onCreate,
  onDelete,
  onMove,
}: {
  active: boolean;
  projectName: string;
  entries: FileEntry[];
  selected?: string;
  onSelect: (path: string) => void;
  onCreate: (parentPath: string, type: "file" | "directory") => void;
  onDelete: (path: string, isDir: boolean) => void;
  onMove: (path: string, isDir: boolean) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: LocalTreeNode }>();
  const expansion = useFolderExpansion(projectName);
  useEffect(() => { if (!active) setContextMenu(undefined); }, [active]);
  const root = useMemo<LocalTreeNode>(
    () => ({
      name: projectName,
      path: "",
      isDir: true,
      children: buildLocalTree(entries),
    }),
    [projectName, entries],
  );
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); window.removeEventListener("keydown", escape); };
  }, [contextMenu]);
  return (
    <>
      <ul className="py-2">
        <LocalTreeItem node={root} depth={0} expansion={expansion} selected={selected} onSelect={onSelect} onContextMenu={(event, node) => { event.preventDefault(); const row = event.currentTarget.getBoundingClientRect(); setContextMenu({ x: Math.min(event.clientX, row.right), y: row.top, node }); }} />
      </ul>
      {contextMenu && createPortal(<div role="menu" className="fixed z-[1000] min-w-40 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-[11px] shadow-2xl dark:border-slate-700 dark:bg-slate-900" style={{ left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 180)), top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - (contextMenu.node.isDir ? 158 : 86))) }} onPointerDown={(event) => event.stopPropagation()}>
        {contextMenu.node.isDir && <><ContextAction icon={<FilePlus2 size={13}/>} label="新建文件" onClick={() => { onCreate(contextMenu.node.path, "file"); setContextMenu(undefined); }}/><ContextAction icon={<FolderPlus size={13}/>} label="新建文件夹" onClick={() => { onCreate(contextMenu.node.path, "directory"); setContextMenu(undefined); }}/></>}
        {contextMenu.node.path && <><ContextAction icon={<Pencil size={13}/>} label="重命名 / 移动" onClick={() => { onMove(contextMenu.node.path, contextMenu.node.isDir); setContextMenu(undefined); }}/><div className="my-1 border-t border-slate-200 dark:border-slate-700"/><ContextAction danger icon={<Trash2 size={13}/>} label={contextMenu.node.isDir ? "删除文件夹" : "删除文件"} onClick={() => { onDelete(contextMenu.node.path, contextMenu.node.isDir); setContextMenu(undefined); }}/></>}
      </div>, document.body)}
    </>
  );
});

function LocalTreeItem({
  expansion,
  node,
  depth,
  selected,
  onSelect,
  onContextMenu,
}: {
  expansion: ReturnType<typeof useFolderExpansion>;
  node: LocalTreeNode;
  depth: number;
  selected?: string;
  onSelect: (path: string) => void;
  onContextMenu: (event: ReactMouseEvent, node: LocalTreeNode) => void;
}) {
  const open = expansion.isOpen(node.path, depth);
  const padding = { paddingLeft: `${depth * 12 + 12}px` };
  if (node.isDir)
    return (
      <li>
        <button
          type="button"
          onClick={() => expansion.toggle(node.path, depth)}
          aria-expanded={open}
          onContextMenu={(event) => onContextMenu(event, node)}
          style={padding}
          className="group flex min-h-6 w-full items-center gap-1 pr-1.5 text-left text-[11px] text-slate-600 transition hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-slate-800/70"
        >
          <ChevronRight
            size={13}
            className={`shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
          />
          {open ? (
            <FolderOpen size={14} className="shrink-0 text-indigo-500" />
          ) : (
            <Folder size={14} className="shrink-0 text-indigo-400" />
          )}
          <span className="truncate font-semibold">{node.name}</span>
        </button>
        <div
          className="grid transition-[grid-template-rows] duration-200"
          style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        >
          <ul className="min-h-0 overflow-hidden">
            {open && node.children.map((child) => (
              <LocalTreeItem
                expansion={expansion}
                key={child.path}
                node={child}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
              />
            ))}
          </ul>
        </div>
      </li>
    );
  const active = selected === node.path;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        onContextMenu={(event) => onContextMenu(event, node)}
        style={padding}
        title={node.path}
        className={`group flex min-h-6 w-full items-center gap-1 pr-1.5 text-left text-[11px] transition ${active ? "bg-gradient-to-r from-indigo-50 to-transparent font-semibold text-indigo-700 dark:from-indigo-500/15 dark:text-indigo-300" : "text-slate-600 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-slate-800/70"}`}
      >
        <span className="w-[13px] shrink-0" />
        <WorkspaceFileIcon path={node.path}
          size={13}
          className={active ? "text-indigo-500" : "text-slate-400"}
        />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}

function ContextAction({ icon, label, danger = false, onClick }: { icon: ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  return <button type="button" role="menuitem" className={`flex w-full items-center gap-2 px-3 py-2 text-left transition ${danger ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10" : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"}`} onClick={onClick}>{icon}{label}</button>;
}
