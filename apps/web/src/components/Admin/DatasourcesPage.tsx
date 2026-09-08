import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Plus,
  Pencil,
  Trash2,
  Database,
  Server,
  UserPlus,
  X,
  Users,
  Search,
} from "lucide-react";
import {
  useDatasources,
  useDatasource,
  useCreateDatasource,
  useUpdateDatasource,
  useDeleteDatasource,
  useDatasourceMembers,
  useDatasourceApprovers,
  Datasource,
} from "../../hooks/useDatasources";
import { useTeams } from "../../hooks/useTeams";
import { useFeedback } from "../common/FeedbackProvider";
import { Select } from "../common/Select";

type Category = "relational" | "nosql";

export function DatasourcesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const category = (
    location.pathname.includes("relational")
      ? "relational"
      : location.pathname.includes("nosql")
        ? "nosql"
        : undefined
  ) as Category | undefined;

  const { data: datasources, isLoading } = useDatasources(category);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingDs, setEditingDs] = useState<Datasource | undefined>();
  const [managingMembersId, setManagingMembersId] = useState<
    string | undefined
  >();

  const title =
    category === "relational"
      ? "关系型数据库"
      : category === "nosql"
        ? "非关系型数据库"
        : "数据源";

  const Icon = category === "relational" ? Database : Server;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Icon size={28} className="text-indigo-600" />
          <div>
            <h1 className="text-2xl font-bold">{title}</h1>
            <p className="text-sm text-muted">
              {category === "relational" && "MySQL、PostgreSQL 等"}
              {category === "nosql" && "Redis、MongoDB 等"}
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            setEditingDs(undefined);
            setModalOpen(true);
          }}
          className="btn btn-primary inline-flex items-center gap-2"
        >
          <Plus size={16} /> 添加数据源
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted">加载中…</p>
      ) : !datasources?.length ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <Icon size={40} className="mx-auto text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-600 dark:text-slate-400">
            暂无数据源
          </p>
          <p className="mt-1 text-xs text-muted">点击右上角添加第一个数据源</p>
        </div>
      ) : (
        <div className="space-y-3">
          {datasources.map((ds) => (
            <DatasourceCard
              key={ds.id}
              ds={ds}
              onEdit={() => {
                setEditingDs(ds);
                setModalOpen(true);
              }}
              onManageMembers={() => setManagingMembersId(ds.id)}
              onQuery={() => navigate(`/db-query/${ds.id}`)}
            />
          ))}
        </div>
      )}

      {modalOpen && (
        <DatasourceModal
          category={category}
          editing={editingDs}
          onClose={() => {
            setModalOpen(false);
            setEditingDs(undefined);
          }}
        />
      )}

      {managingMembersId && (
        <DatasourceMembersModal
          datasourceId={managingMembersId}
          onClose={() => setManagingMembersId(undefined)}
        />
      )}
    </div>
  );
}

function DatasourceCard({
  ds,
  onEdit,
  onManageMembers,
  onQuery,
}: {
  ds: Datasource;
  onEdit: () => void;
  onManageMembers: () => void;
  onQuery: () => void;
}) {
  const deleteMut = useDeleteDatasource();
  const { confirm: askConfirm } = useFeedback();

  const typeLabel: Record<string, string> = {
    mysql: "MySQL",
    postgresql: "PostgreSQL",
    redis: "Redis",
    mongodb: "MongoDB",
  };

  return (
    <div className="panel flex items-center justify-between rounded-lg border p-4 transition hover:border-indigo-200 dark:hover:border-indigo-900">
      <div className="flex items-center gap-4">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-indigo-50 dark:bg-indigo-500/10">
          {ds.category === "relational" ? (
            <Database
              size={24}
              className="text-indigo-600 dark:text-indigo-400"
            />
          ) : (
            <Server
              size={24}
              className="text-indigo-600 dark:text-indigo-400"
            />
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{ds.name}</h3>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400">
              {typeLabel[ds.type] || ds.type}
            </span>
          </div>
          {ds.summary && (
            <p className="mt-0.5 text-xs text-muted">{ds.summary}</p>
          )}
          <div className="mt-1 flex items-center gap-3 text-xs text-muted">
            <span>项目组: {ds.team?.name || "未知"}</span>
            <span className="inline-flex items-center gap-1">
              <Users size={12} /> {ds._count?.members ?? 0} 成员
            </span>
            {ds.category === 'relational' && <span>{ds._count?.approvers ?? 0} 审批人</span>}
          </div>
        </div>
      </div>
      <div className="flex gap-1">
        <button
          onClick={onQuery}
          className="btn btn-primary btn-sm"
          title="查询数据库"
        >
          <Search size={14} />
        </button>
        <button
          onClick={onManageMembers}
          className="btn btn-ghost btn-sm"
          title="管理成员"
        >
          <UserPlus size={14} />
        </button>
        <button onClick={onEdit} className="btn btn-ghost btn-sm" title="编辑">
          <Pencil size={14} />
        </button>
        <button
          onClick={async () => {
            if (
              await askConfirm({
                title: "删除数据源",
                message: `确定删除数据源「${ds.name}」？`,
                confirmText: "删除数据源",
                tone: "danger",
              })
            ) {
              deleteMut.mutate(ds.id);
            }
          }}
          className="btn btn-ghost btn-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
          title="删除"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function DatasourceMembersModal({
  datasourceId,
  onClose,
}: {
  datasourceId: string;
  onClose: () => void;
}) {
  const { data: ds } = useDatasource(datasourceId);
  const { add, remove } = useDatasourceMembers();
  const setApprovers = useDatasourceApprovers();
  const { toast, confirm: askConfirm } = useFeedback();
  const [adding, setAdding] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [approverIds, setApproverIds] = useState<string[]>([]);

  const members = ds?.members ?? [];
  const memberIds = new Set(members.map((m) => m.user.id));
  useEffect(() => { if (ds) setApproverIds((ds.approvers || []).map((user) => user.id)); }, [ds]);

  // 可添加的用户：项目组成员 且 尚未授权
  const teamMembers = ds?.team?.members ?? [];
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
      await add.mutateAsync({ datasourceId, userIds: selectedUserIds });
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
      await remove.mutateAsync({ datasourceId, userIds: [userId] });
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
          <h2 className="text-lg font-semibold">{ds?.name} - 成员管理</h2>
          <button
            onClick={onClose}
            className="btn btn-ghost btn-sm"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <p className="mb-4 text-sm text-muted">
          只能授权 <strong>{ds?.team?.name}</strong> 项目组的成员访问此数据源
        </p>

        {ds?.category === 'relational' && <div className="mb-5 rounded-xl border border-indigo-100 bg-indigo-50/60 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/5"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">审批人列表</h3><p className="mt-1 text-xs text-muted">任意一名审批人同意即可通过；申请人不能审批自己的申请。</p></div><button className="btn btn-primary btn-sm" disabled={!approverIds.length || setApprovers.isPending} onClick={async () => { try { await setApprovers.mutateAsync({ datasourceId, userIds: approverIds }); toast('审批人列表已保存', { tone: 'success' }); } catch (err: any) { toast(err?.response?.data?.message || String(err), { title: '保存失败', tone: 'error' }); } }}>保存审批人</button></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{members.map((member) => <label key={member.user.id} className="choice-row"><input type="checkbox" checked={approverIds.includes(member.user.id)} onChange={() => setApproverIds((value) => value.includes(member.user.id) ? value.filter((id) => id !== member.user.id) : [...value, member.user.id])} /><span className="text-xs font-medium">{member.user.username}</span></label>)}</div>{!members.length && <p className="mt-3 text-xs text-muted">请先添加数据源成员。</p>}</div>}

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
                className="flex items-center justify-between rounded border p-3 text-sm"
              >
                <div>
                  <span className="font-medium">{member.user.username}</span>
                  {member.user.email && (
                    <span className="ml-2 text-xs text-muted">
                      {member.user.email}
                    </span>
                  )}
                </div>
                <button
                  onClick={async () => {
                    if (
                      await askConfirm({
                        title: "移出数据源",
                        message: `确定将 ${member.user.username} 移出此数据源？`,
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

// DatasourceModal 组件保持原样（创建/编辑弹窗）
function DatasourceModal({
  category,
  editing,
  onClose,
}: {
  category?: Category;
  editing?: Datasource;
  onClose: () => void;
}) {
  const { data: teams } = useTeams();
  const { data: detail } = useDatasource(editing?.id);
  const createMut = useCreateDatasource();
  const updateMut = useUpdateDatasource();
  const { toast } = useFeedback();

  const [teamId, setTeamId] = useState(editing?.teamId || "");
  const [name, setName] = useState(editing?.name || "");
  const [type, setType] = useState<string>(editing?.type || "mysql");
  const [config, setConfig] = useState({
    host: editing?.config?.host || "localhost",
    port: editing?.config?.port || (type === "redis" ? 6379 : 3306),
    username: editing?.config?.username || "",
    password: editing?.config?.password || "",
    database: editing?.config?.database || "",
    db: editing?.config?.db || 0,
  });

  useEffect(() => {
    if (!detail?.config) return;
    setConfig({
      host: detail.config.host || "localhost",
      port: detail.config.port || 3306,
      username: detail.config.username || "",
      password: "",
      database: detail.config.database || "",
      db: detail.config.db || 0,
    });
  }, [detail]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing && !teamId) {
      toast("请选择数据源所属的项目组", {
        title: "缺少项目组",
        tone: "warning",
      });
      return;
    }
    try {
      if (editing) {
        await updateMut.mutateAsync({
          id: editing.id,
          data: { name, config },
        });
      } else {
        await createMut.mutateAsync({
          teamId,
          name,
          type: type as any,
          config,
        });
      }
      onClose();
    } catch (err: any) {
      toast(err?.response?.data?.message || String(err), {
        title: editing ? "保存失败" : "创建失败",
        tone: "error",
      });
    }
  };

  const dbTypes =
    category === "relational"
      ? [
          { value: "mysql", label: "MySQL" },
          { value: "postgresql", label: "PostgreSQL" },
        ]
      : category === "nosql"
        ? [
            { value: "redis", label: "Redis" },
            { value: "mongodb", label: "MongoDB" },
          ]
        : [
            { value: "mysql", label: "MySQL" },
            { value: "postgresql", label: "PostgreSQL" },
            { value: "redis", label: "Redis" },
            { value: "mongodb", label: "MongoDB" },
          ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-md p-6">
        <h2 className="mb-4 text-lg font-semibold">
          {editing ? "编辑数据源" : "添加数据源"}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          {!editing && (
            <>
              <div>
                <span className="mb-1 block text-sm font-medium">项目组</span>
                <Select
                  value={teamId}
                  onChange={setTeamId}
                  options={[
                    { value: "", label: "选择项目组" },
                    ...(teams ?? []).map((team) => ({
                      value: team.id,
                      label: team.name,
                    })),
                  ]}
                />
              </div>
              <div>
                <span className="mb-1 block text-sm font-medium">类型</span>
                <Select
                  value={type}
                  onChange={(value) => {
                    setType(value);
                    const newPort =
                      value === "redis"
                        ? 6379
                        : value === "mongodb"
                          ? 27017
                          : 3306;
                    setConfig({ ...config, port: newPort });
                  }}
                  options={dbTypes}
                />
              </div>
            </>
          )}
          <label className="block">
            <span className="mb-1 block text-sm font-medium">名称</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="如: 生产环境MySQL"
              className="input"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">主机</span>
            <input
              type="text"
              value={config.host}
              onChange={(e) => setConfig({ ...config, host: e.target.value })}
              required
              className="input"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">端口</span>
            <input
              type="number"
              value={config.port}
              onChange={(e) =>
                setConfig({ ...config, port: parseInt(e.target.value) })
              }
              required
              className="input"
            />
          </label>
          {(type === "mysql" ||
            type === "postgresql" ||
            type === "mongodb") && (
            <>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">用户名</span>
                <input
                  type="text"
                  value={config.username}
                  onChange={(e) =>
                    setConfig({ ...config, username: e.target.value })
                  }
                  className="input"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">密码</span>
                <input
                  type="password"
                  value={config.password}
                  onChange={(e) =>
                    setConfig({ ...config, password: e.target.value })
                  }
                  className="input"
                  placeholder={editing && detail?.hasPassword ? "已设置；留空则保留" : ""}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">数据库名</span>
                <input
                  type="text"
                  value={config.database}
                  onChange={(e) =>
                    setConfig({ ...config, database: e.target.value })
                  }
                  className="input"
                />
              </label>
            </>
          )}
          {type === "redis" && (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">DB 索引</span>
              <input
                type="number"
                value={config.db}
                onChange={(e) =>
                  setConfig({ ...config, db: parseInt(e.target.value) })
                }
                className="input"
              />
            </label>
          )}
          <div className="flex gap-2 pt-2">
            <button type="submit" className="btn btn-primary flex-1" disabled={Boolean(editing && !detail)}>
              {editing && !detail ? "加载配置…" : editing ? "保存" : "创建"}
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
