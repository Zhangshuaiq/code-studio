import { useState } from "react";
import { Plus, Users as UsersIcon, Trash2, UserPlus, X } from "lucide-react";
import {
  useTeams,
  useTeam,
  useCreateTeam,
  useDeleteTeam,
  useAddTeamMembers,
  useRemoveTeamMembers,
  Team,
} from "../../hooks/useTeams";
import { useUsers, AdminUser } from "../../hooks/useAdmin";
import { useFeedback } from "../common/FeedbackProvider";

export function TeamsPage() {
  const { data: teams, isLoading } = useTeams();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <UsersIcon size={28} className="text-indigo-600" />
          <div>
            <h1 className="text-2xl font-bold">项目组管理</h1>
            <p className="text-sm text-muted">
              组织单位，人员和资源按项目组隔离
            </p>
          </div>
        </div>
        <button
          onClick={() => setCreateModalOpen(true)}
          className="btn btn-primary inline-flex items-center gap-2"
        >
          <Plus size={16} /> 创建项目组
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted">加载中…</p>
      ) : !teams?.length ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <UsersIcon size={40} className="mx-auto text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-600 dark:text-slate-400">
            暂无项目组
          </p>
          <p className="mt-1 text-xs text-muted">点击右上角创建第一个项目组</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => (
            <TeamCard
              key={team.id}
              team={team}
              onViewMembers={() => setSelectedTeamId(team.id)}
            />
          ))}
        </div>
      )}

      {createModalOpen && (
        <CreateTeamModal onClose={() => setCreateModalOpen(false)} />
      )}
      {selectedTeamId && (
        <TeamMembersModal
          teamId={selectedTeamId}
          onClose={() => setSelectedTeamId(undefined)}
        />
      )}
    </div>
  );
}

function TeamCard({
  team,
  onViewMembers,
}: {
  team: Team;
  onViewMembers: () => void;
}) {
  const deleteMut = useDeleteTeam();
  const { confirm: askConfirm } = useFeedback();

  return (
    <div className="panel rounded-lg border p-4 transition hover:border-indigo-200 dark:hover:border-indigo-900">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-indigo-50 dark:bg-indigo-500/10">
            <UsersIcon
              size={20}
              className="text-indigo-600 dark:text-indigo-400"
            />
          </div>
          <div>
            <h3 className="font-semibold">{team.name}</h3>
            {team.description && (
              <p className="mt-0.5 text-xs text-muted">{team.description}</p>
            )}
          </div>
        </div>
        <button
          onClick={async () => {
            if (
              await askConfirm({
                title: "删除项目组",
                message: `确认删除空项目组「${team.name}」？\n仍关联项目、数据源或部署目标时，平台会拒绝删除。`,
                confirmText: "删除项目组",
                tone: "danger",
              })
            ) {
              deleteMut.mutate(team.id);
            }
          }}
          className="btn btn-ghost btn-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
          title="删除"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-4 text-xs text-muted">
          <span>成员: {team._count?.members ?? 0}</span>
          <span>项目: {team._count?.projects ?? 0}</span>
          <span>数据源: {team._count?.datasources ?? 0}</span>
          <span>部署目标: {team._count?.deployTargets ?? 0}</span>
        </div>
        <button
          onClick={onViewMembers}
          className="btn btn-ghost btn-sm inline-flex items-center gap-1 text-indigo-600"
          title="管理成员"
        >
          <UserPlus size={14} />
        </button>
      </div>
    </div>
  );
}

function CreateTeamModal({ onClose }: { onClose: () => void }) {
  const createMut = useCreateTeam();
  const { toast } = useFeedback();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createMut.mutateAsync({
        name,
        description: description || undefined,
      });
      onClose();
    } catch (err: any) {
      toast(err?.response?.data?.message || String(err), {
        title: "创建失败",
        tone: "error",
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-md p-6">
        <h2 className="mb-4 text-lg font-semibold">创建项目组</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">名称</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="如: 前端团队"
              className="input"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">描述（可选）</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="项目组的用途说明"
              className="input resize-none"
            />
          </label>
          <div className="flex gap-2 pt-2">
            <button type="submit" className="btn btn-primary flex-1">
              创建
            </button>
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost flex-1"
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TeamMembersModal({
  teamId,
  onClose,
}: {
  teamId: string;
  onClose: () => void;
}) {
  const { data: team } = useTeam(teamId);
  const { data: allUsers } = useUsers();
  const addMut = useAddTeamMembers();
  const removeMut = useRemoveTeamMembers();
  const { toast, confirm: askConfirm } = useFeedback();
  const [adding, setAdding] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");

  const members = team?.members ?? [];
  const memberIds = new Set(members.map((m) => m.id));
  const availableUsers =
    allUsers?.filter((u: AdminUser) => !memberIds.has(u.id)) ?? [];

  // 搜索过滤
  const filteredUsers = availableUsers.filter(
    (u: AdminUser) =>
      u.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (u.email && u.email.toLowerCase().includes(searchTerm.toLowerCase())),
  );

  const handleAdd = async () => {
    if (selectedUserIds.length === 0) return;
    try {
      await addMut.mutateAsync({ id: teamId, userIds: selectedUserIds });
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
      await removeMut.mutateAsync({ id: teamId, userIds: [userId] });
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
          <h2 className="text-lg font-semibold">{team?.name} - 成员管理</h2>
          <button
            onClick={onClose}
            className="btn btn-ghost btn-sm"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

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
              <div className="max-h-48 space-y-1 overflow-y-auto rounded border p-2">
                {filteredUsers.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted">
                    {searchTerm ? "无匹配用户" : "暂无可添加的用户"}
                  </p>
                ) : (
                  filteredUsers.map((u: AdminUser) => (
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
                key={member.id}
                className="flex items-center justify-between rounded border p-3 text-sm"
              >
                <div>
                  <span className="font-medium">{member.username}</span>
                  {member.email && (
                    <span className="ml-2 text-xs text-muted">
                      {member.email}
                    </span>
                  )}
                </div>
                <button
                  onClick={async () => {
                    if (
                      await askConfirm({
                        title: "移出项目组",
                        message: `确定将 ${member.username} 移出项目组？`,
                        confirmText: "确认移出",
                        tone: "danger",
                      })
                    ) {
                      handleRemove(member.id);
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
