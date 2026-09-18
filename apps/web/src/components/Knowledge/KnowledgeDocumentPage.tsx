import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ArrowLeft,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  Save,
  Search,
} from "lucide-react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import {
  useKnowledgeDocument,
  useKnowledgeMutations,
  useKnowledgeSearch,
  useKnowledgeTree,
} from "../../hooks/useKnowledge";
import { useNavigate, useParams } from "react-router-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { FolderPicker } from "./FolderPicker";
import { useFeedback } from "../common/FeedbackProvider";
import { errText } from "../Settings/ui";
export function KnowledgeDocumentPage() {
  const { id } = useParams();
  const query = useKnowledgeDocument(id);
  const doc = query.data;
  const tree = useKnowledgeTree(doc?.teamId);
  const mutations = useKnowledgeMutations(doc?.teamId);
  const { toast, prompt } = useFeedback();
  const navigate = useNavigate();
  const [content, setContent] = useState("");
  const [summary, setSummary] = useState("");
  const [search, setSearch] = useState("");
  const [moveOpen, setMoveOpen] = useState(false);
  const editorScrollRef = useRef<HTMLElement>(null);
  const results = useKnowledgeSearch(search);
  const editor = useEditor({
    extensions: [
      StarterKit,
      TableKit.configure({ table: { resizable: true } }),
      Placeholder.configure({ placeholder: "开始编写团队知识文档…" }),
      Markdown,
    ],
    content: "",
    contentType: "markdown",
    editorProps: {
      attributes: {
        class:
          "yuque-editor mx-auto min-h-full max-w-5xl px-10 py-8 outline-none",
      },
    },
    onUpdate: ({ editor: e }) => setContent(e.getMarkdown()),
  });
  useEffect(() => {
    if (editor && doc && editor.getMarkdown() !== doc.contentMarkdown) {
      editor.commands.setContent(doc.contentMarkdown || "", {
        contentType: "markdown",
      });
      setContent(doc.contentMarkdown || "");
    }
  }, [editor, doc?.id, doc?.contentMarkdown]);
  const outline = useMemo(() => {
    const headings: Array<{ level: number; title: string; pos: number }> = [];
    editor?.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        headings.push({ level: Number(node.attrs.level), title: node.textContent, pos });
      }
    });
    return headings;
  }, [editor, content, doc?.id]);
  const jumpToHeading = (pos: number) => {
    const container = editorScrollRef.current;
    const heading = editor?.view.nodeDOM(pos);
    if (!(heading instanceof HTMLElement) || !container) return;
    const top = container.scrollTop + heading.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
    container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  };
  if (query.isLoading)
    return (
      <div className="grid h-screen place-items-center text-sm text-muted">
        正在打开知识文档…
      </div>
    );
  if (!doc)
    return (
      <div className="grid h-screen place-items-center text-sm text-muted">
        文档不存在或无权访问
      </div>
    );
  const save = async () => {
    try {
      await mutations.saveDocument.mutateAsync({
        id: doc.id,
        baseVersion: doc.version,
        contentMarkdown: content,
        changeSummary: summary || undefined,
      });
      setSummary("");
      toast("知识文档已保存", { tone: "success" });
    } catch (e) {
      toast(errText(e), { title: "保存失败", tone: "error" });
    }
  };
  const createFolder = async (parentId?: string) => {
    const value = await prompt({
      title: "新建文件夹",
      placeholder: "文件夹名称",
      confirmText: "创建",
    });
    if (value?.trim())
      await mutations.createFolder.mutateAsync({
        teamId: doc.teamId,
        parentId,
        name: value.trim(),
      });
  };
  const createDocument = async (folderId?: string) => {
    const value = await prompt({
      title: "新建文档",
      placeholder: "文档标题",
      confirmText: "创建并打开",
    });
    if (!value?.trim()) return;
    const response = await mutations.createDocument.mutateAsync({
      teamId: doc.teamId,
      folderId,
      title: value.trim(),
    });
    navigate(`/knowledge/documents/${response.data.id}`);
  };
  const moveDocument = async (documentId: string, folderId: string | null) => {
    const source = tree.data?.documents.find((item) => item.id === documentId);
    if (!source || (source.folderId || null) === folderId) return;
    try {
      await mutations.updateDocument.mutateAsync({ id: documentId, folderId });
      setMoveOpen(false);
      toast("文档已移动", { tone: "success" });
    } catch (e) {
      toast(errText(e), { title: "移动失败", tone: "error" });
    }
  };
  return (
    <main className="flex h-screen flex-col overflow-hidden bg-white dark:bg-slate-950">
      <header className="border-b p-4 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              className="icon-btn"
              onClick={() => window.close()}
              title="关闭文档"
            >
              <ArrowLeft size={16} />
            </button>
            <div>
              <div className="text-[10px] text-indigo-600">
                {doc.team?.name} · {doc.requirement ? "需求文档" : "知识文档"}
              </div>
              <h1 className="font-bold">{doc.title}</h1>
            </div>
          </div>
          <button
            className="btn btn-primary"
            disabled={
              content === doc.contentMarkdown ||
              mutations.saveDocument.isPending
            }
            onClick={() => void save()}
          >
            <Save size={14} />
            保存
          </button>
        </div>
        <div className="relative mx-auto mt-3 max-w-2xl">
          <Search
            size={15}
            className="absolute left-3 top-2.5 text-slate-400"
          />
          <input
            className="input w-full pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索我可见的全部知识文档…"
          />
          {search.trim().length >= 2 && (
            <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-xl border bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-900">
              {results.data?.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    navigate(`/knowledge/documents/${item.id}`);
                    setSearch("");
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <FileText size={14} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {item.title}
                  </span>
                  <span className="text-[10px] text-muted">
                    {item.team?.name} / {item.folder?.name || "根目录"}
                  </span>
                </button>
              ))}
              {!results.isLoading && !results.data?.length && (
                <div className="p-4 text-center text-xs text-muted">
                  没有匹配文档
                </div>
              )}
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <span className="text-xs text-muted">所属文件夹</span>
          <span className="max-w-48 truncate text-xs" title={tree.data?.folders.find((x) => x.id === doc.folderId)?.name || "知识库根目录"}>
            {tree.data?.folders.find((x) => x.id === doc.folderId)?.name || "知识库根目录"}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMoveOpen(true)}>移动至…</button>
          <span className="text-[10px] text-muted">
            创建人 {name(doc.createdBy)} · 最后更新 {name(doc.updatedBy)} · v
            {doc.version}
          </span>
        </div>
      </header>
      <PanelGroup direction="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize={22} minSize={14} maxSize={35}>
          <aside className="h-full overflow-y-auto bg-slate-50/60 p-3 dark:bg-slate-900/40">
            <Tree
              folders={tree.data?.folders || []}
              documents={tree.data?.documents || []}
              activeId={doc.id}
              open={(id) => navigate(`/knowledge/documents/${id}`)}
              addFolder={createFolder}
              addDocument={createDocument}
              moveDocument={moveDocument}
            />
          </aside>
        </Panel>
        <PanelResizeHandle className="w-1 cursor-col-resize bg-slate-200 hover:bg-indigo-400 dark:bg-slate-800" />
        <Panel defaultSize={58} minSize={35}>
          <section ref={editorScrollRef} className="h-full overflow-y-auto">
            <EditorContent editor={editor} />
          </section>
        </Panel>
        <PanelResizeHandle className="w-1 cursor-col-resize bg-slate-200 hover:bg-indigo-400 dark:bg-slate-800" />
        <Panel defaultSize={20} minSize={12} maxSize={30}>
          <aside className="h-full overflow-y-auto p-4">
            <div className="mb-3 text-xs font-semibold">文档大纲</div>
            {outline.map((item, index) => (
              <button
                key={index}
                className="block w-full truncate py-1.5 text-left text-xs text-muted hover:text-indigo-600"
                style={{ paddingLeft: (item.level - 1) * 12 }}
                onClick={() => jumpToHeading(item.pos)}
              >
                {item.title}
              </button>
            ))}
          </aside>
        </Panel>
      </PanelGroup>
      <div className="border-t p-3 dark:border-slate-800">
        <input
          className="input w-full"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="本次修改说明（可选）"
        />
      </div>
      {moveOpen && <FolderPicker key={doc.id} folders={tree.data?.folders || []} currentId={doc.folderId} teamName={doc.team?.name || "当前团队"} pending={mutations.updateDocument.isPending} onCancel={() => setMoveOpen(false)} onConfirm={(folderId) => void moveDocument(doc.id, folderId)} />}
    </main>
  );
}
const name = (u?: { username: string; displayName?: string | null }) =>
  u?.displayName || u?.username || "—";

const DOCUMENT_DRAG_TYPE = "application/x-code-studio-knowledge-document";

function Tree({
  folders,
  documents,
  activeId,
  open,
  addFolder,
  addDocument,
  moveDocument,
}: {
  folders: Array<{ id: string; parentId?: string | null; name: string }>;
  documents: Array<{ id: string; folderId?: string | null; title: string }>;
  activeId: string;
  open: (id: string) => void;
  addFolder: (id?: string) => Promise<void>;
  addDocument: (id?: string) => Promise<void>;
  moveDocument: (documentId: string, folderId: string | null) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null | undefined>();
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const canDrop = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(DOCUMENT_DRAG_TYPE);
  const dropProps = (folderId: string | null) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!canDrop(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(folderId);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(undefined);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!canDrop(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(undefined);
      const documentId = event.dataTransfer.getData(DOCUMENT_DRAG_TYPE);
      if (documents.some((item) => item.id === documentId)) void moveDocument(documentId, folderId);
    },
  });
  const render = (folderId: string | null, depth: number): React.ReactNode => {
    const children = folders.filter((item) => (item.parentId || null) === folderId);
    const docs = documents.filter((item) => (item.folderId || null) === folderId);
    return <>
      {children.map((folder) => <div key={folder.id}>
        <div {...dropProps(folder.id)} className={`group flex h-7 items-center gap-1 rounded pr-1 text-xs hover:bg-white dark:hover:bg-slate-800 ${dropTarget === folder.id ? "bg-indigo-100 ring-1 ring-indigo-400 dark:bg-indigo-500/20" : ""}`} style={{ paddingLeft: depth * 12 }}>
          <button type="button" className="grid h-5 w-4 shrink-0 place-items-center" aria-label={collapsed.has(folder.id) ? "展开文件夹" : "收起文件夹"} onClick={() => toggle(folder.id)}>{collapsed.has(folder.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
          <Folder size={13} className="shrink-0 text-amber-500" />
          <button type="button" className="min-w-0 flex-1 truncate text-left font-medium" title={folder.name} onClick={() => toggle(folder.id)}>{folder.name}</button>
          <button type="button" className="invisible grid h-5 w-5 shrink-0 place-items-center group-hover:visible focus:visible" title="在此新建文件夹" aria-label={`在${folder.name}中新建文件夹`} onClick={() => void addFolder(folder.id)}><FolderPlus size={12} /></button>
          <button type="button" className="invisible grid h-5 w-5 shrink-0 place-items-center group-hover:visible focus:visible" title="在此新建文档" aria-label={`在${folder.name}中新建文档`} onClick={() => void addDocument(folder.id)}><FilePlus2 size={12} /></button>
        </div>
        {!collapsed.has(folder.id) && render(folder.id, depth + 1)}
      </div>)}
      {docs.map((item) => <button key={item.id} type="button" draggable onDragStart={(event) => { event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, item.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDropTarget(undefined)} onClick={() => open(item.id)} className={`flex h-7 w-full items-center gap-1.5 rounded pr-1 text-left text-xs ${item.id === activeId ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20" : "hover:bg-white dark:hover:bg-slate-800"}`} style={{ paddingLeft: depth * 12 + 18 }} title={`${item.title}（可拖拽至文件夹）`}><FileText size={12} className="shrink-0" /><span className="truncate">{item.title}</span></button>)}
    </>;
  };
  return (
    <div>
      <div {...dropProps(null)} className={`mb-1 flex h-7 items-center justify-between rounded px-1 ${dropTarget === null ? "bg-indigo-100 ring-1 ring-indigo-400 dark:bg-indigo-500/20" : ""}`}>
        <span className="text-[10px] text-muted">知识库文件 · 拖至此处移入根目录</span>
        <span className="flex"><button type="button" className="icon-btn h-5 w-5" title="在根目录新建文件夹" onClick={() => void addFolder()}><FolderPlus size={12} /></button><button type="button" className="icon-btn h-5 w-5" title="在根目录新建文档" onClick={() => void addDocument()}><FilePlus2 size={12} /></button></span>
      </div>
      {render(null, 0)}
    </div>
  );
}
