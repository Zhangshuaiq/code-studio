import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
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
import { Select } from "../common/Select";
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
  const outline = useMemo(
    () =>
      content.split("\n").flatMap((line) => {
        const match = /^(#{1,6})\s+(.+)$/.exec(line);
        return match ? [{ level: match[1].length, title: match[2] }] : [];
      }),
    [content],
  );
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
          <Select
            size="sm"
            className="w-56"
            value={doc.folderId || "root"}
            options={[
              { value: "root", label: "知识库根目录" },
              ...(tree.data?.folders || []).map((x) => ({
                value: x.id,
                label: x.name,
              })),
            ]}
            onChange={(value) =>
              void mutations.updateDocument.mutateAsync({
                id: doc.id,
                folderId: value === "root" ? null : value,
              })
            }
          />
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
              parentId={undefined}
              folders={tree.data?.folders || []}
              documents={tree.data?.documents || []}
              activeId={doc.id}
              open={(id) => navigate(`/knowledge/documents/${id}`)}
              addFolder={createFolder}
              addDocument={createDocument}
            />
          </aside>
        </Panel>
        <PanelResizeHandle className="w-1 cursor-col-resize bg-slate-200 hover:bg-indigo-400 dark:bg-slate-800" />
        <Panel defaultSize={58} minSize={35}>
          <section className="h-full overflow-y-auto">
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
                onClick={() => {
                  const heading = editor?.view.dom.querySelectorAll(
                    "h1,h2,h3,h4,h5,h6",
                  )[index] as HTMLElement | undefined;
                  heading?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  });
                }}
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
    </main>
  );
}
const name = (u?: { username: string; displayName?: string | null }) =>
  u?.displayName || u?.username || "—";

function Tree({
  parentId,
  folders,
  documents,
  activeId,
  open,
  addFolder,
  addDocument,
}: {
  parentId?: string;
  folders: Array<{ id: string; parentId?: string | null; name: string }>;
  documents: Array<{ id: string; folderId?: string | null; title: string }>;
  activeId: string;
  open: (id: string) => void;
  addFolder: (id?: string) => Promise<void>;
  addDocument: (id?: string) => Promise<void>;
}) {
  const children = folders.filter(
    (item) => (item.parentId || undefined) === parentId,
  );
  const docs = documents.filter(
    (item) => (item.folderId || undefined) === parentId,
  );
  return (
    <div
      className={
        parentId
          ? "ml-3 border-l border-slate-200 pl-2 dark:border-slate-700"
          : ""
      }
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] text-muted">
          {parentId ? "" : "知识库文件"}
        </span>
        <span className="flex">
          <button
            className="icon-btn h-6 w-6"
            title="在此新建文件夹"
            onClick={() => void addFolder(parentId)}
          >
            <FolderPlus size={13} />
          </button>
          <button
            className="icon-btn h-6 w-6"
            title="在此新建文档"
            onClick={() => void addDocument(parentId)}
          >
            <FilePlus2 size={13} />
          </button>
        </span>
      </div>
      {children.map((folder) => (
        <div key={folder.id}>
          <div className="flex items-center gap-1 py-1 text-xs font-medium">
            <Folder size={13} className="text-amber-500" />
            {folder.name}
          </div>
          <Tree
            parentId={folder.id}
            folders={folders}
            documents={documents}
            activeId={activeId}
            open={open}
            addFolder={addFolder}
            addDocument={addDocument}
          />
        </div>
      ))}
      {docs.map((item) => (
        <button
          key={item.id}
          onClick={() => open(item.id)}
          className={`flex w-full items-center gap-1 rounded px-1.5 py-1.5 text-left text-xs ${item.id === activeId ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20" : "hover:bg-white dark:hover:bg-slate-800"}`}
        >
          <FileText size={12} />
          <span className="truncate">{item.title}</span>
        </button>
      ))}
    </div>
  );
}
