import { useEffect, useMemo, useState } from "react";
import {
  BookOpenText,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Plus,
  Trash2,
} from "lucide-react";
import {
  useKnowledgeMutations,
  useKnowledgeTeams,
  useKnowledgeTree,
} from "../../hooks/useKnowledge";
import { useFeedback } from "../common/FeedbackProvider";
import { Select } from "../common/Select";
import { errText } from "../Settings/ui";
export function KnowledgeBasePage() {
  const teams = useKnowledgeTeams();
  const [teamId, setTeamId] = useState("");
  const [folderId, setFolderId] = useState<string>();
  const tree = useKnowledgeTree(teamId);
  const mutations = useKnowledgeMutations(teamId);
  const { prompt, toast, confirm } = useFeedback();
  useEffect(() => {
    if (!teamId && teams.data?.[0]) setTeamId(teams.data[0].id);
  }, [teamId, teams.data]);
  useEffect(() => setFolderId(undefined), [teamId]);
  const folders = useMemo(
    () =>
      tree.data?.folders.filter(
        (x) => (x.parentId || undefined) === folderId,
      ) || [],
    [tree.data, folderId],
  );
  const docs =
    tree.data?.documents.filter(
      (x) => (x.folderId || undefined) === folderId,
    ) || [];
  const createFolder = async () => {
    const name = await prompt({
      title: "新建文件夹",
      message: "团队成员都可以在当前目录创建文件夹",
      placeholder: "文件夹名称",
      confirmText: "创建",
    });
    if (!name?.trim()) return;
    try {
      await mutations.createFolder.mutateAsync({
        teamId,
        parentId: folderId,
        name: name.trim(),
      });
      toast("文件夹已创建", { tone: "success" });
    } catch (e) {
      toast(errText(e), { tone: "error", title: "创建失败" });
    }
  };
  const createDoc = async () => {
    const title = await prompt({
      title: "新建知识文档",
      message: "创建技术规范、架构说明或其他团队知识文档",
      placeholder: "文档标题",
      confirmText: "创建并打开",
    });
    if (!title?.trim()) return;
    try {
      const result = await mutations.createDocument.mutateAsync({
        teamId,
        folderId,
        title: title.trim(),
      });
      window.open(
        `/knowledge/documents/${result.data.id}`,
        "_blank",
        "noopener,noreferrer",
      );
    } catch (e) {
      toast(errText(e), { tone: "error", title: "创建失败" });
    }
  };
  const current = folderId
    ? tree.data?.folders.find((x) => x.id === folderId)
    : undefined;
  const breadcrumb = [] as Array<{ id: string; name: string }>;
  let cursor = current;
  while (cursor) {
    breadcrumb.unshift({ id: cursor.id, name: cursor.name });
    cursor = tree.data?.folders.find((x) => x.id === cursor?.parentId);
  }
  return (
    <main className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-6xl">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow">Team Wiki</div>
            <h1 className="text-2xl font-bold">知识库</h1>
            <p className="mt-1 text-sm text-muted">
              沉淀团队技术规范、架构设计与需求文档。
            </p>
          </div>
          <Select
            value={teamId}
            onChange={setTeamId}
            className="w-60"
            options={(teams.data || []).map((x) => ({
              value: x.id,
              label: x.name,
            }))}
          />
        </header>
        <section>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <nav aria-label="当前文件夹" className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
              <button
                className="font-semibold text-indigo-600"
                onClick={() => setFolderId(undefined)}
              >
                {tree.data?.team.name || "知识库"}
              </button>
              {breadcrumb.map((item, index) => <span key={item.id} className="flex min-w-0 items-center gap-1.5"><ChevronRight size={14} className="shrink-0 text-muted" /><button className={`max-w-48 truncate ${index === breadcrumb.length - 1 ? "font-semibold" : "text-muted hover:text-indigo-600"}`} onClick={() => setFolderId(item.id)} title={item.name}>{item.name}</button></span>)}
            </nav>
            <div className="flex gap-2">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void createFolder()}
                disabled={!teamId}
              >
                <FolderPlus size={14} />
                新建文件夹
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void createDoc()}
                disabled={!teamId}
              >
                <Plus size={14} />
                新建文档
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {folders.map((folder) => (
              <div
                key={folder.id}
                className="card group flex min-h-32 flex-col justify-between p-5 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/5"
              >
                <span className="flex items-start justify-between gap-2"><span className="icon-tile text-indigo-600 dark:text-indigo-300"><Folder size={20} /></span><button className="btn btn-ghost btn-sm text-red-600" title={`删除文件夹 ${folder.name}`} onClick={async () => {
                  if (!await confirm({ title: "删除文件夹", message: `确定删除空文件夹「${folder.name}」？`, confirmText: "删除", tone: "danger" })) return;
                  try { await mutations.deleteFolder.mutateAsync(folder.id); toast("文件夹已删除", { tone: "success" }); }
                  catch (error) { toast(errText(error), { tone: "error", title: "删除失败" }); }
                }}><Trash2 size={14} /></button></span>
                <button className="flex w-full min-w-0 items-center justify-between gap-2 text-left" onClick={() => setFolderId(folder.id)}><span className="truncate text-sm font-semibold" title={folder.name}>{folder.name}</span><ChevronRight size={16} className="shrink-0 text-muted group-hover:text-indigo-600" /></button>
              </div>
            ))}
            {docs.map((doc) => (
              <a
                key={doc.id}
                href={`/knowledge/documents/${doc.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="card group flex min-h-32 flex-col justify-between p-5 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/5"
              >
                <div className="flex items-start justify-between gap-2"><span className="icon-tile text-indigo-600 dark:text-indigo-300"><FileText size={20} /></span><BookOpenText size={16} className="text-muted group-hover:text-indigo-500" /></div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold" title={doc.title}>{doc.title}</div>
                  <div className="mt-1 text-xs text-muted">
                    {doc.requirementId ? "需求文档" : "知识文档"} · v
                    {doc.version} ·{" "}
                    {new Date(doc.updatedAt).toLocaleString("zh-CN")}
                  </div>
                </div>
              </a>
            ))}
            {!folders.length && !docs.length && (
              <div className="card col-span-full py-20 text-center text-sm text-muted">
                当前文件夹为空，可以新建文件夹或文档。
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
