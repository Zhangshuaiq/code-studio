import { useEffect, useMemo, useState } from "react";
import {
  BookOpenText,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Plus,
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
  const { prompt, toast } = useFeedback();
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
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b p-4 dark:border-slate-800">
            <div className="flex items-center gap-2 text-sm">
              <button
                className="font-semibold text-indigo-600"
                onClick={() => setFolderId(undefined)}
              >
                {tree.data?.team.name || "知识库"}
              </button>
              {current && (
                <>
                  <ChevronRight size={14} />
                  <span>{current.name}</span>
                </>
              )}
            </div>
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
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {folderId && (
              <button
                className="flex w-full items-center gap-3 px-5 py-3 text-left text-sm text-muted hover:bg-slate-50 dark:hover:bg-slate-900"
                onClick={() => setFolderId(current?.parentId || undefined)}
              >
                … 返回上级
              </button>
            )}
            {folders.map((folder) => (
              <button
                key={folder.id}
                className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-slate-50 dark:hover:bg-slate-900"
                onClick={() => setFolderId(folder.id)}
              >
                <Folder size={18} className="text-amber-500" />
                <span className="text-sm font-medium">{folder.name}</span>
                <ChevronRight size={14} className="ml-auto text-muted" />
              </button>
            ))}
            {docs.map((doc) => (
              <a
                key={doc.id}
                href={`/knowledge/documents/${doc.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-900"
              >
                <FileText size={18} className="text-indigo-500" />
                <div>
                  <div className="text-sm font-medium">{doc.title}</div>
                  <div className="mt-1 text-[10px] text-muted">
                    {doc.requirementId ? "需求文档" : "知识文档"} · v
                    {doc.version} ·{" "}
                    {new Date(doc.updatedAt).toLocaleString("zh-CN")}
                  </div>
                </div>
                <BookOpenText size={14} className="ml-auto text-muted" />
              </a>
            ))}
            {!folders.length && !docs.length && (
              <div className="py-20 text-center text-sm text-muted">
                当前文件夹为空，可以新建文件夹或文档。
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
