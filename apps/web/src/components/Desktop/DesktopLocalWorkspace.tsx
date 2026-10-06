import Editor from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CaseSensitive,
  ChevronRight,
  CodeXml,
  Eye,
  File,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  ExternalLink,
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
  syncWorkspaceModels,
  workspaceModelUri,
  workspacePathFromUri,
} from "../../lib/monaco";
import { useTheme } from "../../store/theme";
import { DesktopLocalAgentPanel } from "./DesktopLocalAgentPanel";
import { DesktopLocalPreview } from "./DesktopLocalPreview";
import { DesktopLocalOutputPanel } from "./DesktopLocalOutputPanel";
import { useDesktopJavaRun } from "./DesktopJavaRun";
import { Select } from "../common/Select";

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
  repository: boolean;
  branch: string | null;
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
}
interface FileView {
  readOnly?: boolean;
  kind: "text" | "image" | "pdf" | "spreadsheet" | "unsupported";
  mime: string;
  reason?: string;
  sheets?: Array<{ name: string; rows: string[][] }>;
  truncated?: boolean;
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
  const [error, setError] = useState("");
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
  const [navigation, setNavigation] = useState<NavigationEntry[]>([]);
  const [navigationIndex, setNavigationIndex] = useState(-1);
  const [sidebarMode, setSidebarMode] = useState<"files" | "git">("files");
  const [workspaceTab, setWorkspaceTab] = useState<
    "code" | "preview" | "history"
  >("code");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus>();
  const [gitLoading, setGitLoading] = useState(false);
  const [gitSelection, setGitSelection] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [gitDiff, setGitDiff] = useState<{
    path: string;
    working: string;
    staged: string;
  }>();
  const [gitRefs, setGitRefs] = useState<GitRefs>({
    branches: [],
    remotes: [],
  });
  const [gitRemote, setGitRemote] = useState("");
  const [target, setTarget] = useState<{ line: number; column: number }>();
  const [editor, setEditor] = useState<any>();
  const [monaco, setMonaco] = useState<any>();
  const activePathRef = useRef<string>();
  const openFileRef = useRef<
    (
      path: string,
      line?: number,
      column?: number,
      record?: boolean,
    ) => Promise<void>
  >(async () => {});
  const javaRun = useDesktopJavaRun(project.id, files.some((file) => file.path.endsWith(".java")), active,
    Object.values(fileStates).some((file) => !file.view.readOnly && file.content !== file.savedContent),
    (frame) => { setWorkspaceTab("code"); if (frame.path) void openFileRef.current(frame.path, frame.line, frame.column); });
  useEffect(() => {
    if (!editor || !monaco || !activePath) return;
    const collection = editor.createDecorationsCollection([
      ...(javaRun.breakpoints[activePath] || []).map((line) => ({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: false, glyphMarginClassName: "desktop-java-breakpoint", glyphMarginHoverMessage: { value: "断点（点击移除）" } } })),
      ...(javaRun.pausedFrame?.path === activePath ? [{ range: new monaco.Range(javaRun.pausedFrame.line, 1, javaRun.pausedFrame.line, 1), options: { isWholeLine: true, className: "desktop-java-current-line" } }] : []),
    ]);
    return () => collection.clear();
  }, [editor, monaco, activePath, javaRun.breakpoints, javaRun.pausedFrame]);
  const openRequestRef = useRef(0);
  const navigationRef = useRef<NavigationEntry[]>([]);
  const navigationIndexRef = useRef(-1);
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
        const body = (await response.json()) as { items: FileEntry[] };
        setFiles(body.items);
      })
      .catch((reason) => setError(String(reason?.message || reason)))
      .finally(() => setLoadingTree(false));
  }, [project.id]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/local/projects/${project.id}/language/prepare`, { method: "POST", signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [project.id]);

  useEffect(() => {
    if (sidebarMode === "git" || workspaceTab === "code") void loadGitStatus();
  }, [sidebarMode, workspaceTab, project.id]);

  useEffect(() => {
    if (!monaco) return;
    const providers = installDesktopLanguageProviders(monaco, project.id);
    return () => providers.dispose();
  }, [monaco, project.id]);

  useEffect(() => {
    if (
      !quickOpen ||
      !["@", "#"].includes(quickQuery[0]) ||
      !quickQuery.slice(1).trim()
    ) {
      setEverywhereResults([]);
      setEverywhereLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setEverywhereLoading(true);
      try {
        const query = encodeURIComponent(quickQuery.slice(1).trim());
        const endpoint =
          quickQuery[0] === "@"
            ? `symbols?query=${query}`
            : `search?query=${query}&regex=false&caseSensitive=false`;
        const response = await fetch(
          `/api/local/projects/${project.id}/${endpoint}`,
          { signal: controller.signal },
        );
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.message || `HTTP ${response.status}`);
        setEverywhereResults(body.items);
      } catch (reason: any) {
        if (reason?.name !== "AbortError")
          setError(String(reason?.message || reason));
      } finally {
        if (!controller.signal.aborted) setEverywhereLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [quickOpen, quickQuery, project.id]);

  useEffect(() => {
    if (!monaco) return;
    const controller = new AbortController();
    void fetch(`/api/local/projects/${project.id}/index`, {
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
        syncWorkspaceModels(monaco, project.id, sourceIndex.files);
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
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
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
    const requestId = ++openRequestRef.current;
    const cached = fileStates[path];
    if (path === activePathRef.current && cached && line) {
      // Debug/definition navigation within the current file must not reload it
      // from disk or discard edits made while paused.
      setTarget({ line, column: column || 1 });
      return;
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
      return;
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
      if (requestId !== openRequestRef.current) return;
      const nextView: FileView = {
        kind: body.kind || "text",
        mime: body.mime || "application/octet-stream",
        reason: body.reason,
        readOnly: Boolean(body.readOnly),
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
      const nextContent = typeof body.content === "string" ? body.content : "";
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
      if (record) {
        const entry = { path, line: line || 1, column: column || 1 };
        const current = navigationRef.current[navigationIndexRef.current];
        if (
          !current ||
          current.path !== entry.path ||
          current.line !== entry.line ||
          current.column !== entry.column
        ) {
          const next = [
            ...navigationRef.current.slice(0, navigationIndexRef.current + 1),
            entry,
          ].slice(-100);
          setNavigation(next);
          setNavigationIndex(next.length - 1);
        }
      }
    } catch (reason: any) {
      if (requestId === openRequestRef.current)
        setError(
          reason?.name === "AbortError"
            ? "文件读取超时，请重试。"
            : String(reason?.message || reason),
        );
    } finally {
      window.clearTimeout(timeout);
      if (requestId === openRequestRef.current) setLoadingFile(false);
    }
  }
  openFileRef.current = openFile;

  async function closeFile(path: string) {
    const state = fileStates[path];
    if (
      state &&
      state.content !== state.savedContent &&
      !window.confirm(`“${path.split("/").pop()}”尚未保存，确定关闭吗？`)
    )
      return;
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
    const nextIndex = navigationIndexRef.current + offset;
    const entry = navigationRef.current[nextIndex];
    if (!entry) return;
    await openFile(entry.path, entry.line, entry.column, false);
    setNavigationIndex(nextIndex);
  }

  function chooseEverywhereItem(item: EverywhereItem) {
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
    if (!activePath || fileView.kind !== "text" || fileView.readOnly) return;
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
      setSavedContent(content);
      setFileVersion(body.version);
      setExternalChanged(false);
      setFileStates((current) =>
        current[activePath]
          ? {
              ...current,
              [activePath]: {
                ...current[activePath],
                content,
                savedContent: content,
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
        return kept.size ? kept : available;
      });
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setGitLoading(false);
    }
  }

  async function reloadWorkspaceFiles(refreshActive = true) {
    try {
      const response = await fetch(`/api/local/projects/${project.id}/files`);
      const body = await response.json();
      if (response.ok) setFiles(body.items);
      if (refreshActive && activePath) await openFile(activePath, undefined, undefined, false);
      if (monaco) {
        const indexResponse = await fetch(
          `/api/local/projects/${project.id}/index`,
        );
        const indexBody = await indexResponse.json();
        if (indexResponse.ok) {
          syncWorkspaceModels(monaco, project.id, indexBody.files);
          setIndexTruncated(Boolean(indexBody.truncated));
        }
      }
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    }
  }

  async function createWorkspaceEntry(parentPath: string, type: "file" | "directory") {
    const label = type === "file" ? "文件" : "文件夹";
    const name = window.prompt(`请输入${label}名称`);
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

  async function showGitDiff(path: string) {
    try {
      const response = await fetch(
        `/api/local/projects/${project.id}/git/diff?path=${encodeURIComponent(path)}`,
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message || `HTTP ${response.status}`);
      setGitDiff(body);
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    }
  }

  async function commitSelected() {
    const message = commitMessage.trim();
    if (!message || !gitSelection.size) return;
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
      await loadGitStatus();
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setGitLoading(false);
    }
  }

  async function createBranch() {
    const branch = window.prompt("新分支名称");
    if (branch?.trim()) await checkoutBranch(branch.trim(), true);
  }

  async function syncGit(operation: "fetch" | "pull" | "push") {
    if (
      operation === "push" &&
      !window.confirm(
        `确定将 ${gitStatus?.branch || "当前分支"} 推送到 ${gitRemote || "上游"} 吗？`,
      )
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
      await loadGitStatus();
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setGitLoading(false);
    }
  }

  const title = useMemo(
    () => (activePath ? activePath.split("/").pop() : "选择文件"),
    [activePath],
  );
  function mountEditor(instance: any, monacoInstance: any) {
    setEditor(instance);
    setMonaco(monacoInstance);
    instance.onDidChangeModel(() => {
      const targetPath = workspacePathFromUri(instance.getModel()?.uri);
      if (!targetPath || targetPath === activePathRef.current) return;
      const position = instance.getPosition();
      void openFileRef.current(
        targetPath,
        position?.lineNumber,
        position?.column,
      );
    });
    const navigateToDefinition = async (currentEditor: any, requestedPosition?: any) => {
      try {
        const model = currentEditor.getModel();
        const position = requestedPosition || currentEditor.getPosition();
        if (!model || !position) return;
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
              }),
            },
          );
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setError(body.message || `代码跳转失败（HTTP ${response.status}）`);
            return;
          }
          const results = (await response.json()).result || [];
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
        if (!definition)
          definition = (await monacoInstance.languages.getDefinitionAtPosition(model, position))?.find(
            (item: any) => workspacePathFromUri(item.uri) !== sourcePath,
          ) || (await monacoInstance.languages.getDefinitionAtPosition(model, position))?.[0];
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
        if (targetPath === activePathRef.current) {
          currentEditor.setPosition(targetPosition);
          currentEditor.revealPositionInCenter(targetPosition);
          currentEditor.focus();
          return;
        }
        await openFileRef.current(targetPath, targetPosition.lineNumber, targetPosition.column);
      } catch (reason: any) {
        setError(`代码跳转失败：${String(reason?.message || reason)}`);
      }
      };
    instance.onMouseDown((event: any) => {
      if (event.target?.type === monacoInstance.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position) {
        const file = workspacePathFromUri(instance.getModel()?.uri);
        if (file?.endsWith(".java") && !file.startsWith("@java-source/")) javaRun.toggleBreakpoint.current(file, event.target.position.lineNumber);
        return;
      }
      const browserEvent = event.event?.browserEvent;
      if (!(browserEvent?.metaKey || browserEvent?.ctrlKey) || !event.target?.position) return;
      browserEvent.preventDefault();
      browserEvent.stopPropagation();
      void navigateToDefinition(instance, event.target.position);
    });
    instance.addAction({
      id: "desktop-open-definition",
      label: "转到定义",
      keybindings: [monacoInstance.KeyCode.F12],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1,
      run: navigateToDefinition,
    });
  }
  return (
    <div className="h-full bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <PanelGroup
        direction="horizontal"
        className="workspace-frame h-full"
        autoSaveId="desktop-ws-h"
      >
        <Panel defaultSize={28} minSize={18} maxSize={50}>
          <div className="flex h-full min-h-0 flex-col bg-slate-50/70 dark:bg-slate-900/40">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 px-3 text-[11px] font-semibold dark:border-slate-800">
              <Bot size={13} className="text-indigo-500" />
              智能助手
            </div>
            <DesktopLocalAgentPanel projectId={project.id} onFilesChanged={() => { void reloadWorkspaceFiles(); void loadGitStatus(); }} />
          </div>
        </Panel>
        <PanelResizeHandle className="resize-handle-x" />
        <Panel minSize={30}>
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
              <div className="flex items-center">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={navigationIndex <= 0}
                  onClick={() => void moveInHistory(-1)}
                  title="后退"
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
                  title="前进"
                >
                  <ArrowRight size={15} />
                </button>
              </div>
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
              </div>
              <div className="ml-auto flex items-center gap-2">
                {javaRun.toolbar}
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
            {gitDiff && (
              <div
                className="fixed inset-0 z-40 flex justify-center bg-slate-950/45 px-6 py-[8vh]"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget)
                    setGitDiff(undefined);
                }}
              >
                <div className="flex w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 text-slate-100 shadow-2xl">
                  <div className="flex items-center border-b border-slate-800 px-4 py-3">
                    <GitBranch size={15} className="mr-2" />
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                      {gitDiff.path}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm mr-2"
                      onClick={() => {
                        const path = gitDiff.path;
                        setGitDiff(undefined);
                        setWorkspaceTab("code");
                        setSidebarMode("files");
                        void openFile(path);
                      }}
                      title="在编辑器中打开完整源码"
                    >
                      <ExternalLink size={13} />
                      打开源码
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setGitDiff(undefined)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[11px] leading-5">
                    <code>
                      {gitDiff.staged ? `# 已暂存\n${gitDiff.staged}\n` : ""}
                      {gitDiff.working ||
                        (!gitDiff.staged
                          ? "该文件暂无可显示的文本差异（可能是未跟踪文件或二进制文件）。"
                          : "")}
                    </code>
                  </pre>
                </div>
              </div>
            )}
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
                workspaceTab === "code" || workspaceTab === "history"
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
                        {sidebarMode === "files"
                          ? "资源管理器"
                          : `源代码管理${gitStatus?.files.length ? ` · ${gitStatus.files.length}` : ""}`}
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
                                onSelect={(path) => void openFile(path)}
                                onCreate={(parentPath, type) => void createWorkspaceEntry(parentPath, type)}
                                onDelete={(path, isDir) => void deleteWorkspaceEntry(path, isDir)}
                              />
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2 border-t border-slate-200 px-3 py-2 dark:border-slate-800">
                            <GitBranch size={13} className="text-slate-400" />
                            {gitStatus?.repository ? <Select ariaLabel="当前分支" className="min-w-0 flex-1" buttonClassName="border-0 bg-transparent shadow-none" size="sm" value={gitStatus.branch || ""} disabled={gitLoading} onChange={(branch) => void checkoutBranch(branch)} options={gitRefs.branches.map((branch) => ({ value: branch, label: branch }))} /> : <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">非 Git 仓库</span>}
                            {gitStatus?.files.length ? <button type="button" className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" onClick={() => { setWorkspaceTab("history"); setSidebarMode("git"); }}>{gitStatus.files.length} 项变更</button> : null}
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
                                  <Select
                                    ariaLabel="当前分支"
                                    className="min-w-0 flex-1"
                                    size="sm"
                                    value={gitStatus.branch || ""}
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
                              <FileCode2 size={12} />
                              <span className="truncate">
                                {path.split("/").pop()}
                              </span>
                              {changed && (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />
                              )}
                              <span
                                role="button"
                                tabIndex={0}
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
                    <div className="min-h-0 flex-1">
                      {loadingFile ? (
                        <div className="grid h-full place-items-center text-sm text-slate-400">
                          <LoaderCircle size={20} className="animate-spin" />
                        </div>
                      ) : activePath ? (
                        <LocalFileViewer
                          projectId={project.id}
                          path={activePath}
                          view={fileView}
                        >
                          {fileView.kind === "text" ? (
                            <Editor
                              path={workspaceModelUri(project.id, activePath)}
                              language={monacoLang(activePath)}
                              value={content}
                              theme={theme === "dark" ? "vs-dark" : "light"}
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
                                readOnly: Boolean(fileView.readOnly),
                                glyphMargin: activePath.endsWith(".java") && !fileView.readOnly,
                                automaticLayout: true,
                                minimap: { enabled: true },
                                fontSize: 12,
                                lineHeight: 19,
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
                    {workspaceTab === "code" && javaRun.panel}
                    {workspaceTab === "code" && terminalOpen && (
                      <div className="relative h-[34%] min-h-40 shrink-0 border-t border-slate-700">
                        <DesktopLocalOutputPanel
                          projectId={project.id}
                          onClose={() => setTerminalOpen(false)}
                        />
                      </div>
                    )}
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
          </section>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function LocalFileViewer({
  projectId,
  path,
  view,
  children,
}: {
  projectId: string;
  path: string;
  view: FileView;
  children: React.ReactNode;
}) {
  const [sheetIndex, setSheetIndex] = useState(0);
  useEffect(() => setSheetIndex(0), [path]);
  if (view.kind === "text") return <>{children}</>;
  const rawUrl = `/api/local/projects/${projectId}/file-preview?path=${encodeURIComponent(path)}`;
  if (view.kind === "image")
    return (
      <div className="grid h-full overflow-auto bg-[linear-gradient(45deg,#e5e7eb_25%,transparent_25%),linear-gradient(-45deg,#e5e7eb_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#e5e7eb_75%),linear-gradient(-45deg,transparent_75%,#e5e7eb_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px] p-6 dark:opacity-90">
        <img
          src={rawUrl}
          alt={path}
          className="m-auto max-h-full max-w-full object-contain shadow-xl"
        />
      </div>
    );
  if (view.kind === "pdf")
    return (
      <iframe
        src={rawUrl}
        title={path}
        className="h-full w-full border-0 bg-white"
      />
    );
  if (view.kind === "spreadsheet") {
    const sheets = view.sheets || [];
    const sheet = sheets[sheetIndex];
    return (
      <div className="flex h-full min-h-0 flex-col bg-white dark:bg-slate-950">
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 p-2 dark:border-slate-800">
          {sheets.map((item, index) => (
            <button
              key={`${item.name}:${index}`}
              type="button"
              onClick={() => setSheetIndex(index)}
              className={`rounded-lg px-3 py-1.5 text-xs ${index === sheetIndex ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}
            >
              {item.name}
            </button>
          ))}
          {view.truncated && (
            <span className="ml-auto self-center text-[10px] text-amber-500">
              大表格仅展示前 20 个工作表、500 行、100 列
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {sheet ? (
            <table className="min-w-full border-collapse font-mono text-[11px]">
              <tbody>
                {sheet.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <th className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-2 py-1 text-right font-normal text-slate-400 dark:border-slate-700 dark:bg-slate-900">
                      {rowIndex + 1}
                    </th>
                    {row.map((cell, columnIndex) => (
                      <td
                        key={columnIndex}
                        className="max-w-80 whitespace-pre-wrap border border-slate-200 px-2 py-1 align-top dark:border-slate-700"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="grid h-full place-items-center text-sm text-slate-400">
              表格中没有工作表
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center px-8 text-center text-sm text-slate-400">
      <div>
        <File size={28} className="mx-auto mb-3" />
        <p className="font-semibold text-slate-600 dark:text-slate-300">
          暂不支持预览此文件
        </p>
        <p className="mt-1 text-xs">
          {view.reason || "该二进制格式暂时无法在工作区内打开"}
        </p>
      </div>
    </div>
  );
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
  const root: LocalTreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const entry of entries.filter((item) => item.type === "file")) {
    const parts = entry.path.split("/");
    let current = root;
    parts.forEach((name, index) => {
      const nodePath = parts.slice(0, index + 1).join("/");
      let child = current.children.find((item) => item.name === name);
      if (!child) {
        child = {
          name,
          path: nodePath,
          isDir: index < parts.length - 1,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    });
  }
  const sort = (node: LocalTreeNode) => {
    node.children.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
    );
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function LocalFileTree({
  active,
  projectName,
  entries,
  selected,
  onSelect,
  onCreate,
  onDelete,
}: {
  active: boolean;
  projectName: string;
  entries: FileEntry[];
  selected?: string;
  onSelect: (path: string) => void;
  onCreate: (parentPath: string, type: "file" | "directory") => void;
  onDelete: (path: string, isDir: boolean) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: LocalTreeNode }>();
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
        <LocalTreeItem node={root} depth={0} selected={selected} onSelect={onSelect} onContextMenu={(event, node) => { event.preventDefault(); const row = event.currentTarget.getBoundingClientRect(); setContextMenu({ x: Math.min(event.clientX, row.right), y: row.top, node }); }} />
      </ul>
      {contextMenu && createPortal(<div role="menu" className="fixed z-[1000] min-w-40 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-[11px] shadow-2xl dark:border-slate-700 dark:bg-slate-900" style={{ left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 180)), top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - (contextMenu.node.isDir ? 126 : 54))) }} onPointerDown={(event) => event.stopPropagation()}>
        {contextMenu.node.isDir && <><ContextAction icon={<FilePlus2 size={13}/>} label="新建文件" onClick={() => { onCreate(contextMenu.node.path, "file"); setContextMenu(undefined); }}/><ContextAction icon={<FolderPlus size={13}/>} label="新建文件夹" onClick={() => { onCreate(contextMenu.node.path, "directory"); setContextMenu(undefined); }}/></>}
        {contextMenu.node.path && <><div className="my-1 border-t border-slate-200 dark:border-slate-700"/><ContextAction danger icon={<Trash2 size={13}/>} label={contextMenu.node.isDir ? "删除文件夹" : "删除文件"} onClick={() => { onDelete(contextMenu.node.path, contextMenu.node.isDir); setContextMenu(undefined); }}/></>}
      </div>, document.body)}
    </>
  );
}

function LocalTreeItem({
  node,
  depth,
  selected,
  onSelect,
  onContextMenu,
}: {
  node: LocalTreeNode;
  depth: number;
  selected?: string;
  onSelect: (path: string) => void;
  onContextMenu: (event: ReactMouseEvent, node: LocalTreeNode) => void;
}) {
  const [open, setOpen] = useState(depth <= 1);
  const padding = { paddingLeft: `${depth * 12 + 12}px` };
  if (node.isDir)
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
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
            {node.children.map((child) => (
              <LocalTreeItem
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
        <FileCode2
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
