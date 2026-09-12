import { useEffect, useState } from "react";
import {
  Atom,
  Coffee,
  Hexagon,
  Terminal,
  FolderPlus,
  Plus,
  Trash2,
  Users,
  UserPlus,
  X,
  ArrowUpRight,
  CalendarDays,
  Check,
  Sparkles,
  GitBranch,
  Link2,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import {
  Project,
  useProjects,
  useProject,
  useProjectMutations,
  useProjectMembers,
  useProjectRepository,
  useProjectRepositoryMutations,
} from "../../hooks/useProjects";
import { useTeams } from "../../hooks/useTeams";
import { useFeedback } from "../common/FeedbackProvider";
import { Select } from "../common/Select";

const LANG_LABEL: Record<string, string> = {
  "react-vite": "React + Vite",
  java: "Spring Boot",
  node: "Node.js (Express)",
  python: "Python (FastAPI)",
  "react-native": "React Native (Expo)",
};
const LANG_ICON: Record<string, LucideIcon> = {
  "react-vite": Atom,
  java: Coffee,
  node: Hexagon,
  python: Terminal,
  "react-native": Smartphone,
};
// 语言色调（图标底座）
const LANG_TILE: Record<string, string> = {
  "react-vite":
    "bg-sky-100 text-sky-600 ring-sky-200/70 dark:bg-sky-500/15 dark:text-sky-400 dark:ring-sky-500/20",
  java: "bg-orange-100 text-orange-600 ring-orange-200/70 dark:bg-orange-500/15 dark:text-orange-400 dark:ring-orange-500/20",
  node: "bg-emerald-100 text-emerald-600 ring-emerald-200/70 dark:bg-emerald-500/15 dark:text-emerald-400 dark:ring-emerald-500/20",
  python:
    "bg-amber-100 text-amber-700 ring-amber-200/70 dark:bg-amber-500/15 dark:text-amber-400 dark:ring-amber-500/20",
  "react-native":
    "bg-violet-100 text-violet-700 ring-violet-200/70 dark:bg-violet-500/15 dark:text-violet-400 dark:ring-violet-500/20",
};

const LANG_DESC: Record<string, string> = {
  "react-vite": "现代 Web 前端与交互页面",
  java: "企业级 REST API 与服务",
  node: "轻量、快速的后端接口",
  python: "AI 与数据服务接口",
  "react-native": "Expo Android 移动应用与云手机预览",
};

export function ProjectList({ onOpen }: { onOpen: (p: Project) => void }) {
  const { data: projects = [], isLoading } = useProjects();
  const [showNew, setShowNew] = useState(false);
  const [managingMembersId, setManagingMembersId] = useState<
    string | undefined
  >();
  const [managingRepositoryId, setManagingRepositoryId] = useState<
    string | undefined
  >();
  const { toast } = useFeedback();

  return (
    <div className="page-shell max-w-7xl">
      <section className="relative mb-8 overflow-hidden rounded-[28px] border border-indigo-100/80 bg-gradient-to-br from-white via-indigo-50/70 to-violet-50/80 p-6 shadow-[0_18px_55px_-30px_rgba(79,70,229,0.45)] sm:p-8 dark:border-indigo-500/15 dark:from-slate-900 dark:via-indigo-950/35 dark:to-violet-950/25">
        <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-indigo-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 right-1/3 h-52 w-52 rounded-full bg-violet-400/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-indigo-200/80 bg-white/70 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-indigo-600 shadow-sm dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300">
              <Sparkles size={12} /> AI Project Workspace
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl dark:text-white">
              把想法变成可运行的代码
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              从一句需求开始，在同一个工作区里完成生成、预览、版本管理与部署。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden rounded-2xl border border-white/80 bg-white/60 px-4 py-2.5 text-right shadow-sm backdrop-blur sm:block dark:border-slate-700/60 dark:bg-slate-900/50">
              <div className="text-lg font-bold text-slate-900 dark:text-white">
                {projects.length}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Projects
              </div>
            </div>
            <button
              onClick={() => setShowNew(true)}
              className="btn btn-primary"
            >
              <Plus size={17} /> 新建项目
            </button>
          </div>
        </div>
      </section>

      <div className="mb-4 flex items-end justify-between">
        <div>
          <div className="eyebrow">Your work</div>
          <h2 className="mt-1 text-lg font-bold tracking-tight text-slate-900 dark:text-white">
            最近项目
          </h2>
        </div>
        {projects.length > 0 && (
          <span className="text-xs text-muted">
            共 {projects.length} 个项目
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-[178px] animate-pulse rounded-2xl border border-slate-200/80 bg-white/60 dark:border-slate-800 dark:bg-slate-900/50"
            />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState onNew={() => setShowNew(true)} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              onOpen={onOpen}
              onManageMembers={() => setManagingMembersId(p.id)}
              onManageRepository={() => setManagingRepositoryId(p.id)}
            />
          ))}
        </div>
      )}

      {showNew && (
        <NewProjectModal
          onClose={() => setShowNew(false)}
          onCreated={(p) => {
            setShowNew(false);
            if (p.status === 'active') onOpen(p);
            else toast('项目已创建，代码仓库正在后台导入，完成后即可打开。', { title: '已进入导入队列', tone: 'success' });
          }}
        />
      )}

      {managingMembersId && (
        <ProjectMembersModal
          projectId={managingMembersId}
          onClose={() => setManagingMembersId(undefined)}
        />
      )}

      {managingRepositoryId && (
        <ProjectRepositoryModal
          projectId={managingRepositoryId}
          onClose={() => setManagingRepositoryId(undefined)}
        />
      )}
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
  onManageMembers,
  onManageRepository,
}: {
  project: Project;
  onOpen: (p: Project) => void;
  onManageMembers: () => void;
  onManageRepository: () => void;
}) {
  const { remove, retryImport } = useProjectMutations();
  const { toast } = useFeedback();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cleanupDeployment, setCleanupDeployment] = useState(false);
  const Icon = LANG_ICON[project.language] ?? Terminal;
  const tile =
    LANG_TILE[project.language] ??
    "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400";
  const createdAt = new Date(project.createdAt);
  const canManage =
    project.accessRole === "owner" || project.accessRole === "maintainer";
  const createdLabel = Number.isNaN(createdAt.getTime())
    ? "最近创建"
    : createdAt.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  const importing = ['import_queued', 'importing'].includes(project.status);
  const importFailed = project.status === 'import_failed';

  return (
    <div className="group relative min-w-0">
      <button
        onClick={() => project.status === 'active' && onOpen(project)}
        disabled={project.status !== 'active'}
        className="card relative flex h-[178px] w-full flex-col items-stretch overflow-hidden p-5 text-left transition-all duration-300 enabled:hover:-translate-y-1 enabled:hover:border-indigo-200 enabled:hover:shadow-[0_20px_45px_-24px_rgba(79,70,229,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 disabled:cursor-default dark:enabled:hover:border-indigo-500/30"
      >
        <span className="pointer-events-none absolute -right-12 -top-16 h-36 w-36 rounded-full bg-indigo-400/0 blur-2xl transition-colors duration-300 group-hover:bg-indigo-400/10" />
        <div className="flex items-start justify-between">
          <span
            className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ring-1 ${tile}`}
          >
            <Icon size={22} strokeWidth={2} />
          </span>
          <span
            className={`mt-1 inline-flex items-center gap-1 text-[10px] font-semibold ${importFailed ? 'text-red-500' : importing ? 'text-amber-500' : 'text-slate-400 transition group-hover:text-indigo-500'}`}
            title={importFailed && project.accessRole === 'owner' ? project.importError || '导入失败' : undefined}
          >
            {importFailed ? '导入失败' : importing ? (project.status === 'importing' ? '正在导入' : '等待导入') : <>打开 <ArrowUpRight size={13} /></>}
          </span>
        </div>
        <div className="mt-4 min-w-0">
          <div className="truncate text-[15px] font-bold text-slate-900 transition group-hover:text-indigo-600 dark:text-slate-100 dark:group-hover:text-indigo-400">
            {project.name}
          </div>
          <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
            {LANG_DESC[project.language] ?? "代码生成项目"}
          </p>
          <div className="mt-3 flex min-w-0 items-center gap-2 text-[10px] text-slate-400">
            <span className="rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {LANG_LABEL[project.language] ?? project.language}
            </span>
            {project.team && (
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <Users size={11} /> {project.team.name}
              </span>
            )}
            {project.remote && (
              <span
                className="inline-flex min-w-0 items-center gap-1 truncate text-indigo-500 dark:text-indigo-400"
                title={project.remote.remoteUrl}
              >
                <GitBranch size={11} /> {project.remote.branch || '自动识别'}
              </span>
            )}
            <span className="ml-auto inline-flex shrink-0 items-center gap-1">
              <CalendarDays size={11} /> {createdLabel}
            </span>
          </div>
        </div>
      </button>
      <div className="absolute right-3 top-3 flex gap-1 rounded-xl border border-slate-200/80 bg-white/90 p-1 opacity-0 shadow-md backdrop-blur transition group-hover:opacity-100 group-focus-within:opacity-100 dark:border-slate-700 dark:bg-slate-900/90">
        {importFailed && project.accessRole === 'owner' && <button
          onClick={async (event) => {
            event.stopPropagation();
            try {
              await retryImport.mutateAsync(project.id);
              toast('项目已重新进入导入队列', { tone: 'success' });
            } catch (error: any) {
              toast(error?.response?.data?.message ?? '重新导入失败', { tone: 'error' });
            }
          }}
          className="rounded-lg px-2 py-1 text-[10px] font-semibold text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-500/10"
          title={project.importError || '重新导入'}
        >重试导入</button>}
        {canManage && !importing && <button
          onClick={(e) => {
            e.stopPropagation();
            onManageRepository();
          }}
          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-500/10"
          title={project.remote ? "修改代码仓库" : "配置代码仓库"}
        >
          <Link2 size={14} />
        </button>}
        {project.team && canManage && !importing && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onManageMembers();
            }}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-500/10"
            title="管理成员"
          >
            <UserPlus size={14} />
          </button>
        )}
        {project.accessRole === "owner" && !importing && <button
          onClick={(e) => {
            e.stopPropagation();
            setCleanupDeployment(false);
            setDeleteOpen(true);
          }}
          title="删除项目"
          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
        >
          <Trash2 size={14} />
        </button>}
      </div>
      {deleteOpen && <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && setDeleteOpen(false)}>
        <div role="dialog" aria-modal="true" aria-labelledby={`delete-project-${project.id}`} className="card w-full max-w-md overflow-hidden" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-start gap-3 px-5 pb-4 pt-5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300"><Trash2 size={18} /></span>
            <div className="min-w-0 flex-1"><h2 id={`delete-project-${project.id}`} className="font-semibold">删除项目</h2><p className="mt-1 text-sm leading-6 text-muted">确定删除项目「{project.name}」吗？项目数据和代码文件删除后不可恢复。</p></div>
            <button className="icon-btn" aria-label="关闭" onClick={() => setDeleteOpen(false)}><X size={16} /></button>
          </div>
          <label className="mx-5 mb-5 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <input type="checkbox" className="mt-1" checked={cleanupDeployment} onChange={(event) => setCleanupDeployment(event.target.checked)} />
            <span><span className="block text-sm font-medium">尝试删除关联部署</span><span className="mt-1 block text-xs leading-5 text-muted">系统只会尝试停止一次关联部署。即使操作失败，项目仍会继续删除；该选项不保证 Kubernetes 中的部署资源一定被删除。</span></span>
          </label>
          <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/35">
            <button className="btn btn-secondary" disabled={remove.isPending} onClick={() => setDeleteOpen(false)}>取消</button>
            <button className="btn bg-red-600 text-white hover:bg-red-700" disabled={remove.isPending} onClick={async () => {
              try {
                const result = await remove.mutateAsync({ id: project.id, cleanupDeployment });
                setDeleteOpen(false);
                const failed = result?.deploymentCleanup?.attempted && !result?.deploymentCleanup?.succeeded;
                toast(failed ? '项目已开始删除，但关联部署停止失败，请在部署中心确认' : '项目已开始删除', { tone: failed ? 'warning' : 'success' });
              } catch (error: any) {
                toast(error?.response?.data?.message ?? '删除项目失败', { tone: 'error' });
              }
            }}>{remove.isPending ? '正在删除…' : '确定删除'}</button>
          </div>
        </div>
      </div>}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="surface-soft flex flex-col items-center gap-4 border-dashed py-20 text-center">
      <div className="relative grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-indigo-100 to-violet-100 text-indigo-600 ring-1 ring-indigo-200 dark:from-indigo-500/15 dark:to-violet-500/15 dark:text-indigo-300 dark:ring-indigo-500/20">
        <FolderPlus size={28} />
        <span className="absolute -right-1 -top-1 grid h-6 w-6 place-items-center rounded-full bg-white text-indigo-600 shadow-md dark:bg-slate-800">
          <Plus size={13} />
        </span>
      </div>
      <div>
        <p className="text-base font-bold">创建你的第一个项目</p>
        <p className="mt-1 text-sm text-muted">
          选择技术栈，然后用自然语言开始构建
        </p>
      </div>
      <button
        onClick={onNew}
        className="btn btn-primary inline-flex items-center gap-1.5"
      >
        <Plus size={16} /> 新建项目
      </button>
    </div>
  );
}

function NewProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const { create } = useProjectMutations();
  const { data: teams } = useTeams();
  const { toast } = useFeedback();
  const [source, setSource] = useState<"blank" | "git">("blank");
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("react-vite");
  const [teamId, setTeamId] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");

  async function handleCreate() {
    if (!name.trim() || (source === "git" && !repositoryUrl.trim())) return;
    try {
      const p = await create.mutateAsync({
        source,
        name: name.trim(),
        language,
        teamId: teamId || undefined,
        repositoryUrl: source === "git" ? repositoryUrl.trim() : undefined,
        defaultBranch: source === "git" ? defaultBranch.trim() || undefined : undefined,
      });
      onCreated(p);
    } catch (error: any) {
      const message = error?.response?.data?.message ?? "项目创建失败";
      toast(Array.isArray(message) ? message.join("；") : message, { title: "创建失败", tone: "error" });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card animate-fade-in w-full max-w-xl overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200/80 bg-gradient-to-r from-indigo-50/80 to-violet-50/60 px-6 py-5 dark:border-slate-800 dark:from-indigo-500/10 dark:to-violet-500/5">
          <div>
            <div className="eyebrow">New workspace</div>
            <h2 className="mt-1 flex items-center gap-2 text-lg font-bold">
              <FolderPlus size={19} className="text-indigo-500" /> 新建项目
            </h2>
          </div>
          <button onClick={onClose} className="icon-btn" title="关闭">
            <X size={17} />
          </button>
        </div>
        <div className="space-y-5 p-6">
          <div>
            <label className="label mb-2">创建方式</label>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" onClick={() => setSource("blank")} className={`rounded-2xl border p-4 text-left transition ${source === "blank" ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-500/10 dark:bg-indigo-500/10" : "border-slate-200 dark:border-slate-700"}`}>
                <FolderPlus size={18} className="text-indigo-500" />
                <span className="mt-2 block text-sm font-bold">创建新项目</span>
                <span className="mt-1 block text-[11px] text-muted">创建空白工作区，再通过 AI 生成代码</span>
              </button>
              <button type="button" onClick={() => setSource("git")} className={`rounded-2xl border p-4 text-left transition ${source === "git" ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-500/10 dark:bg-indigo-500/10" : "border-slate-200 dark:border-slate-700"}`}>
                <GitBranch size={18} className="text-indigo-500" />
                <span className="mt-2 block text-sm font-bold">从 Git 导入</span>
                <span className="mt-1 block text-[11px] text-muted">后台拉取已有仓库，完成后进入工作区</span>
              </button>
            </div>
          </div>
          <div>
            <label className="label mb-1.5">项目名称</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="例如 customer-portal"
              className="input"
            />
          </div>
          <div>
            <label className="label mb-2">选择技术栈</label>
            <div className="grid grid-cols-2 gap-2.5">
              {Object.keys(LANG_LABEL).map((id) => {
                const Icon = LANG_ICON[id];
                const active = language === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setLanguage(id)}
                    className={`relative flex items-center gap-3 rounded-2xl border p-3 text-left transition-all ${
                      active
                        ? "border-indigo-300 bg-indigo-50/80 ring-2 ring-indigo-500/10 dark:border-indigo-500/50 dark:bg-indigo-500/10"
                        : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950/40 dark:hover:border-slate-600"
                    }`}
                  >
                    <span
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ring-1 ${LANG_TILE[id]}`}
                    >
                      <Icon size={17} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-bold">
                        {LANG_LABEL[id]}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted">
                        {LANG_DESC[id]}
                      </span>
                    </span>
                    {active && (
                      <span className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-indigo-600 text-white">
                        <Check size={10} strokeWidth={3} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="label mb-1.5">项目组（可选）</label>
            <Select
              value={teamId}
              onChange={setTeamId}
              options={[
                { value: "", label: "个人项目，不关联项目组" },
                ...(teams ?? []).map((team) => ({
                  value: team.id,
                  label: team.name,
                })),
              ]}
            />
          </div>
          {source === "git" && <div className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-950/30">
            <div className="mb-3 flex items-start gap-2.5">
              <Link2 size={16} className="mt-0.5 shrink-0 text-indigo-500" />
              <div>
                <label className="label">代码仓库</label>
                <p className="mt-0.5 text-[11px] leading-5 text-muted">
                  公开仓库可直接拉取；私有仓库使用账户设置中与仓库主机匹配的个人 Token。
                </p>
              </div>
            </div>
            <input
              value={repositoryUrl}
              onChange={(e) => setRepositoryUrl(e.target.value)}
              placeholder="https://github.com/team/repository.git"
              className="input"
            />
            {repositoryUrl.trim() && (
              <div className="mt-3 sm:w-1/2">
                <label className="label mb-1.5">默认分支</label>
                <input
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                  placeholder="自动识别（例如 main）"
                  className="input"
                />
              </div>
            )}
          </div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200/80 bg-slate-50/70 px-6 py-4 dark:border-slate-800 dark:bg-slate-950/30">
          <button onClick={onClose} className="btn btn-ghost">
            取消
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || (source === "git" && !repositoryUrl.trim()) || create.isPending}
            className="btn btn-primary"
          >
            {create.isPending ? "提交中…" : (source === "git" ? "开始后台导入" : "创建项目")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectRepositoryModal({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const repository = useProjectRepository(projectId);
  const { save, remove } = useProjectRepositoryMutations(projectId);
  const { toast, confirm: askConfirm } = useFeedback();
  const [remoteUrl, setRemoteUrl] = useState("");
  const [branch, setBranch] = useState("main");

  useEffect(() => {
    if (!repository.data) return;
    setRemoteUrl(repository.data.remoteUrl);
    setBranch(repository.data.branch || "main");
  }, [repository.data]);

  async function handleSave() {
    try {
      await save.mutateAsync({
        remoteUrl: remoteUrl.trim(),
        branch: branch.trim() || "main",
      });
      toast("项目仓库地址已保存。推送时会使用当前登录用户自己的 Git 凭据。", {
        title: "仓库配置已更新",
        tone: "success",
      });
      onClose();
    } catch (error: any) {
      const message = error?.response?.data?.message ?? String(error);
      toast(Array.isArray(message) ? message.join("；") : message, {
        title: "保存失败",
        tone: "error",
      });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card animate-fade-in w-full max-w-lg overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200/80 bg-gradient-to-r from-indigo-50/80 to-violet-50/60 px-6 py-5 dark:border-slate-800 dark:from-indigo-500/10 dark:to-violet-500/5">
          <div>
            <div className="eyebrow">Project repository</div>
            <h2 className="mt-1 flex items-center gap-2 text-lg font-bold">
              <GitBranch size={19} className="text-indigo-500" /> 项目代码仓库
            </h2>
          </div>
          <button onClick={onClose} className="icon-btn" title="关闭">
            <X size={17} />
          </button>
        </div>
        <div className="space-y-4 p-6">
          <div className="rounded-xl border border-indigo-200/70 bg-indigo-50/60 px-3.5 py-3 text-xs leading-5 text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/5 dark:text-indigo-300">
            此处是项目共享配置，不保存用户名或 Token。每位成员推送时，平台会使用该成员在“账户与 Git”中配置的身份和凭据。
          </div>
          <div>
            <label className="label mb-1.5">仓库地址（HTTPS）</label>
            <input
              autoFocus
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://github.com/team/repository.git"
              className="input"
            />
          </div>
          <div>
            <label className="label mb-1.5">默认分支</label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="input"
            />
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-slate-200/80 bg-slate-50/70 px-6 py-4 dark:border-slate-800 dark:bg-slate-950/30">
          {repository.data ? (
            <button
              onClick={async () => {
                if (
                  await askConfirm({
                    title: "解除代码仓库",
                    message: "只会删除项目中的仓库地址，不会删除远程仓库或个人凭据。",
                    confirmText: "解除关联",
                    tone: "danger",
                  })
                ) {
                  await remove.mutateAsync();
                  onClose();
                }
              }}
              disabled={remove.isPending}
              className="btn btn-ghost text-red-500"
            >
              解除关联
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button onClick={onClose} className="btn btn-ghost">
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={!remoteUrl.trim() || save.isPending}
              className="btn btn-primary"
            >
              {save.isPending ? "保存中…" : "保存仓库"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectMembersModal({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { data: project } = useProject(projectId);
  const { add, remove, updateRole } = useProjectMembers();
  const { toast, confirm: askConfirm } = useFeedback();
  const [adding, setAdding] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRole, setSelectedRole] = useState<
    "maintainer" | "developer" | "viewer"
  >("developer");

  const members = (project?.members ?? []).filter(
    (member) => member.user.id !== project?.userId,
  );
  const memberIds = new Set(members.map((m) => m.user.id));

  // 可添加的用户：项目组成员 且 尚未授权
  const teamMembers = project?.team?.members ?? [];
  const availableUsers = teamMembers.filter((u) => !memberIds.has(u.id));

  // 搜索过滤
  const filteredUsers = availableUsers.filter(
    (u) =>
      u.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (u.email && u.email.toLowerCase().includes(searchTerm.toLowerCase())),
  );

  const handleAdd = async () => {
    if (selectedUserIds.length === 0) return;
    try {
      await add.mutateAsync({
        projectId,
        userIds: selectedUserIds,
        role: selectedRole,
      });
      setSelectedUserIds([]);
      setSearchTerm("");
      setAdding(false);
    } catch (err: any) {
      toast(err?.response?.data?.message || String(err), {
        title: "添加成员失败",
        tone: "error",
      });
    }
  };

  const handleRemove = async (userId: string) => {
    try {
      await remove.mutateAsync({ projectId, userIds: [userId] });
    } catch (err: any) {
      toast(err?.response?.data?.message || String(err), {
        title: "移除成员失败",
        tone: "error",
      });
    }
  };

  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-lg p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{project?.name} - 成员管理</h2>
          <button onClick={onClose} className="icon-btn" title="关闭">
            <X size={16} />
          </button>
        </div>

        <p className="mb-4 text-sm text-muted">
          只能授权 <strong>{project?.team?.name}</strong> 项目组的成员访问此项目
        </p>

        <div className="mb-4">
          {!adding ? (
            <button
              onClick={() => setAdding(true)}
              className="btn btn-primary btn-sm inline-flex items-center gap-1"
            >
              <UserPlus size={14} /> 添加成员
            </button>
          ) : (
            <div className="space-y-3">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="搜索用户名或邮箱..."
                className="input text-sm"
                autoFocus
              />
              <div className="surface-soft max-h-48 space-y-1 overflow-y-auto p-2">
                {filteredUsers.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted">
                    {searchTerm ? "无匹配用户" : "暂无可添加的用户"}
                  </p>
                ) : (
                  filteredUsers.map((u) => (
                    <label key={u.id} className="choice-row">
                      <input
                        type="checkbox"
                        checked={selectedUserIds.includes(u.id)}
                        onChange={() => toggleUser(u.id)}
                      />
                      <div className="flex-1">
                        <span className="font-medium">{u.username}</span>
                        {u.email && (
                          <span className="ml-2 text-xs text-muted">
                            {u.email}
                          </span>
                        )}
                      </div>
                    </label>
                  ))
                )}
              </div>
              {selectedUserIds.length > 0 && (
                <p className="text-xs text-muted">
                  已选择 {selectedUserIds.length} 个用户
                </p>
              )}
              <div className="flex gap-2">
                <Select
                  value={selectedRole}
                  onChange={(value) =>
                    setSelectedRole(
                      value as "maintainer" | "developer" | "viewer",
                    )
                  }
                  options={[
                    { value: "maintainer", label: "维护者" },
                    { value: "developer", label: "开发者" },
                    { value: "viewer", label: "只读成员" },
                  ]}
                  size="sm"
                  className="w-32"
                />
                <button
                  onClick={handleAdd}
                  disabled={selectedUserIds.length === 0}
                  className="btn btn-primary btn-sm flex-1"
                >
                  添加{" "}
                  {selectedUserIds.length > 0 && `(${selectedUserIds.length})`}
                </button>
                <button
                  onClick={() => {
                    setAdding(false);
                    setSelectedUserIds([]);
                    setSearchTerm("");
                  }}
                  className="btn btn-ghost btn-sm"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="max-h-96 space-y-2 overflow-y-auto">
          {!members.length ? (
            <p className="py-8 text-center text-sm text-muted">
              暂无成员，点击上方添加
            </p>
          ) : (
            members.map((member) => (
              <div
                key={member.user.id}
                className="flex items-center justify-between rounded-xl border border-slate-200/80 bg-slate-50/60 p-3 text-sm dark:border-slate-800 dark:bg-slate-950/30"
              >
                <div>
                  <span className="font-medium">{member.user.username}</span>
                  {member.user.email && (
                    <span className="ml-2 text-xs text-muted">
                      {member.user.email}
                    </span>
                  )}
                </div>
                <Select
                  value={member.role}
                  onChange={(role) =>
                    updateRole.mutate({
                      projectId,
                      userId: member.user.id,
                      role: role as "maintainer" | "developer" | "viewer",
                    })
                  }
                  options={[
                    { value: "maintainer", label: "维护者" },
                    { value: "developer", label: "开发者" },
                    { value: "viewer", label: "只读" },
                  ]}
                  size="sm"
                  className="ml-auto w-28"
                />
                <button
                  onClick={async () => {
                    if (
                      await askConfirm({
                        title: "移出项目",
                        message: `确定将 ${member.user.username} 移出此项目？`,
                        confirmText: "确认移出",
                        tone: "danger",
                      })
                    ) {
                      handleRemove(member.user.id);
                    }
                  }}
                  className="btn btn-ghost btn-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                  title="移除"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
