import { useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceFileIcon } from '../CodeEditor/WorkspaceFileIcon';
import {
  ChevronRight,
  Files,
  Folder,
  FolderOpen,
  Search,
  X,
} from "lucide-react";
import { isFastIndexLoading, useSessionFiles, useWorkspaceSearch, useWorkspaceFastSymbols, useWorkspaceFastIndexStatus } from "../../hooks/useSessionFiles";
import { fetchWorkspaceFile, type WorkspaceSearchResult } from '../../hooks/useSessionFiles';
import { useQueryClient } from '@tanstack/react-query';
import { useEditorTabs } from '../../store/editorTabs';
import { api } from '../../lib/api';
import { verifyFastSymbolTarget, staleFastSymbol, type FastSymbolTarget } from '../../lib/fast-symbol-target';
import { buildWorkspaceFileTree } from '../../lib/workspace-file-tree';
import { useFolderExpansion } from '../../hooks/useFolderExpansion';

interface TreeNode {
  name: string;
  path: string; // 文件的相对路径；文件夹为其前缀
  isDir: boolean;
  children: TreeNode[];
}

// 把 ["src/App.jsx","package.json"] 这类相对路径列表构造成嵌套树
function buildTree(paths: string[]): TreeNode[] {
  return buildWorkspaceFileTree(paths);
}

export function FileTree({
  sessionId,
  rootName = "项目",
  selected,
  onSelect,
}: {
  sessionId?: string;
  rootName?: string;
  selected?: string;
  onSelect?: (path: string, line?: number | null, column?: number | null) => void;
}) {
  const { data: paths = [], isLoading, isError } = useSessionFiles(sessionId);
  const [searchInput, setSearchInput] = useState("");
  const expansion = useFolderExpansion(sessionId || '');
  const [searchQuery, setSearchQuery] = useState("");
  const [targetNotice, setTargetNotice] = useState('');
  const queryClient = useQueryClient();
  const targetSequence = useRef(0);
  const context = useRef({ sessionId, selected, searchInput });
  context.current = { sessionId, selected, searchInput };
  useEffect(() => { setTargetNotice(''); return () => { targetSequence.current++; }; }, [sessionId, selected, searchInput]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearchQuery(searchInput.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [searchInput]);
  useEffect(() => {
    const focusGlobalSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", focusGlobalSearch);
    return () => window.removeEventListener("keydown", focusGlobalSearch);
  }, []);
  const symbolMode = searchQuery.startsWith('@');
  const textSearch = useWorkspaceSearch(sessionId, symbolMode ? '' : searchQuery);
  const symbolSearch = useWorkspaceFastSymbols(sessionId, symbolMode ? searchQuery.slice(1).trim() : '');
  const search = symbolMode ? symbolSearch : textSearch;
  const fastStatus = useWorkspaceFastIndexStatus(sessionId, paths.some(path => /\.java$/i.test(path)));
  const indexLoading = isFastIndexLoading(symbolMode ? symbolSearch.data?.index ?? fastStatus.data?.index : fastStatus.data?.index);
  const indexBusy = symbolMode && (symbolSearch.error as any)?.response?.data?.code === 'FAST_INDEX_BUSY';
  const tree = useMemo(() => buildTree(paths), [paths]);

  // 用项目名作为根节点，文件从根目录展示
  const root: TreeNode = useMemo(() => ({
    name: rootName,
    path: "",
    isDir: true,
    children: tree,
  }), [rootName, tree]);

  async function openSearchResult(item: WorkspaceSearchResult) {
    if (!symbolMode) { onSelect?.(item.path, item.line, item.column); return; }
    if (!sessionId) return;
    const sequence = ++targetSequence.current;
    const origin = context.current;
    const current = () => sequence === targetSequence.current && context.current.sessionId === origin.sessionId && context.current.selected === origin.selected && context.current.searchInput === origin.searchInput;
    const drafts = useEditorTabs.getState().drafts;
    setTargetNotice('正在确认代码位置…');
    try {
      // Read through the authorized API even for an overlay; this also refreshes
      // an unopened target and avoids displaying an old React Query file cache.
      const file = await fetchWorkspaceFile(sessionId, item.path);
      if (!current()) return;
      const draft = drafts[item.path];
      const content = draft && draft.content !== draft.baseline ? draft.content : file.content;
      await verifyFastSymbolTarget(item as FastSymbolTarget, content);
      if (!current()) return;
      if (useEditorTabs.getState().drafts !== drafts) throw staleFastSymbol();
      queryClient.setQueryData(['file', sessionId, item.path], file);
      useEditorTabs.getState().syncDraft(item.path, file.content);
      setTargetNotice('');
      onSelect?.(item.path, item.line, item.column);
    } catch (error: any) {
      if (!current()) return;
      if (error.code === 'FAST_SYMBOL_STALE' || error.response?.status === 404) {
        setTargetNotice('代码已变化，正在更新搜索结果…');
        try {
          await api.post(`/sessions/${sessionId}/language/index-refresh`, {});
          if (current()) { await symbolSearch.refetch(); if (current()) setTargetNotice('代码已变化，请从更新后的结果打开'); }
        } catch { if (current()) setTargetNotice('代码已变化，请稍后重新搜索'); }
      } else setTargetNotice(error.response?.data?.message || '暂时无法确认代码位置，请稍后重试');
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-50/80 text-sm dark:bg-slate-950/35">
      <div className="flex min-h-[42px] items-center gap-2 border-b border-slate-200/80 px-3 text-xs font-bold text-slate-600 dark:border-slate-800 dark:text-slate-300">
        <Files size={14} className="text-indigo-500" />
        <span>项目文件</span>
        {paths.length > 0 && (
          <span className="ml-auto rounded-full bg-slate-200/70 px-2 py-0.5 text-[9px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {paths.length}
          </span>
        )}
      </div>
      {targetNotice && <p role="status" className="px-3 py-2 text-[10px] text-muted">{targetNotice}</p>}
      <div className="relative border-b border-slate-200/80 p-2 dark:border-slate-800">
        <Search size={13} className="absolute left-4 top-4 text-slate-400" />
        <input
          ref={searchInputRef}
          className="input h-8 w-full pl-8 pr-8 text-xs"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="搜索文件或代码，@ 搜索 Java 符号…"
          title="全局搜索 (⌘/Ctrl+Shift+F)"
        />
        {searchInput && (
          <button
            className="absolute right-3 top-3.5 p-1 text-muted"
            onClick={() => setSearchInput("")}
            aria-label="清空搜索"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {(indexLoading || indexBusy) && <div className="border-b border-slate-200/80 px-3 py-2 text-[10px] text-muted dark:border-slate-800" role="status"><span>{indexBusy ? '正在等待索引资源…' : `正在更新代码索引${fastStatus.data?.index.files ? ` · ${fastStatus.data.index.files} 个文件` : ''}…`}</span><div className="mt-1 h-0.5 overflow-hidden rounded bg-indigo-100 dark:bg-indigo-950"><div className="h-full w-1/3 animate-pulse bg-indigo-400" /></div></div>}
      {searchQuery ? (
        <div className="py-1">
          {search.isLoading ? (
            <p className="p-4 text-xs text-muted">正在搜索…</p>
          ) : search.isError && !indexBusy ? (
            <p className="p-4 text-xs text-red-500">搜索失败，请稍后重试</p>
          ) : (
            (search.data?.items ?? []).map((item, index) => (
              <button
                key={`${item.path}:${item.line}:${index}`}
                onClick={() => void openSearchResult(item)}
                className="block w-full border-b px-3 py-2 text-left text-xs hover:bg-indigo-50 dark:border-slate-800 dark:hover:bg-indigo-500/10"
              >
                <span className="block truncate font-medium" title={item.path}>
                  {item.path}{item.line ? `:${item.line}` : ""}
                </span>
                <span className="mt-1 block truncate font-mono text-[10px] text-muted">
                  {item.preview}
                </span>
              </button>
            ))
          )}
          {!search.isLoading && !search.isError && !indexLoading && !search.data?.items.length && (
            <p className="p-6 text-center text-xs text-muted">没有匹配结果</p>
          )}
          {search.data?.truncated && (
            <p className="p-2 text-center text-[10px] text-amber-600">
              {symbolMode && indexLoading ? '索引更新中，先展示已有匹配结果' : symbolMode && symbolSearch.data?.overlayTruncated ? '未保存代码索引未完整，请保存文件后重试' : symbolMode && symbolSearch.data?.sourceTruncated ? '部分文件尚未完成索引' : '结果较多，请缩小关键词'}
            </p>
          )}
        </div>
      ) : isLoading ? (
        <p className="px-4 py-4 text-xs text-muted">加载中…</p>
      ) : isError ? (
        <p className="px-4 py-4 text-xs text-muted">尚无文件（先生成一次）</p>
      ) : paths.length === 0 ? (
        <p className="px-4 py-4 text-xs text-muted">还没有文件（先生成一次）</p>
      ) : (
        <ul className="py-2">
          <TreeItem
            expansion={expansion}
            node={root}
            depth={0}
            selected={selected}
            onSelect={onSelect}
          />
        </ul>
      )}
    </div>
  );
}

function TreeItem({
  expansion,
  node,
  depth,
  selected,
  onSelect,
}: {
  expansion: ReturnType<typeof useFolderExpansion>;
  node: TreeNode;
  depth: number;
  selected?: string;
  onSelect?: (path: string, line?: number | null, column?: number | null) => void;
}) {
  // 默认只展开浅层（root + 第一层），更深的收起，避免一次展开一大片
  const open = expansion.isOpen(node.path, depth);
  const pad = { paddingLeft: `${depth * 12 + 12}px` };

  if (node.isDir) {
    return (
      <li>
        <button
          onClick={() => expansion.toggle(node.path, depth)}
          aria-expanded={open}
          style={pad}
          className="flex min-h-7 w-full items-center gap-1.5 pr-2 text-left text-xs text-slate-600 transition hover:bg-slate-200/60 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/70 dark:hover:text-white"
        >
          <ChevronRight
            size={13}
            className="shrink-0 text-slate-400 transition-transform duration-150 ease-out"
            style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
          />
          {open ? (
            <FolderOpen size={14} className="shrink-0 text-indigo-500" />
          ) : (
            <Folder size={14} className="shrink-0 text-indigo-400" />
          )}
          <span className="truncate font-semibold">{node.name}</span>
        </button>
        {/* 高度平滑过渡（grid-rows 0fr↔1fr）*/}
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out"
          style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        >
          <ul className="min-h-0 overflow-hidden">
            {open && node.children.map((c) => (
              <TreeItem
                expansion={expansion}
                key={c.path}
                node={c}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </div>
      </li>
    );
  }

  const active = selected === node.path;
  return (
    <li>
      <button
        onClick={() => onSelect?.(node.path)}
        style={pad}
        title={node.path}
        className={`flex min-h-7 w-full items-center gap-1.5 truncate pr-2 text-left text-xs transition ${
          active
            ? "bg-gradient-to-r from-indigo-50 to-transparent font-semibold text-indigo-700 dark:from-indigo-500/15 dark:text-indigo-300"
            : "text-slate-600 hover:bg-slate-200/60 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-200"
        }`}
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
