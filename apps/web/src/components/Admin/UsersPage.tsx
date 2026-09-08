import { useState } from "react";
import { Plus, Trash2, KeyRound, Ban, CheckCircle2 } from "lucide-react";
import {
  AdminUser,
  useAdminUsers,
  useAdminUserOps,
  useAdminRoles,
} from "../../hooks/useAdmin";
import { PageHeader, EmptyState, Card, Field, errText } from "../Settings/ui";
import { useFeedback } from "../common/FeedbackProvider";

export function UsersPage() {
  const { data: users = [] } = useAdminUsers();
  const { data: roles = [] } = useAdminRoles();
  const { create } = useAdminUserOps();

  const [showForm, setShowForm] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const toggleRole = (id: string) =>
    setRoleIds((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id],
    );

  async function add() {
    setErr("");
    if (!f.username?.trim() || !f.password) return setErr("用户名和密码必填");
    try {
      await create.mutateAsync({
        username: f.username.trim(),
        email: f.email?.trim() || undefined,
        displayName: f.displayName?.trim() || undefined,
        password: f.password,
        roleIds,
      });
      setF({});
      setRoleIds([]);
      setShowForm(false);
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? errText(e));
    }
  }

  return (
    <div>
      <PageHeader
        title="用户"
        desc="平台账户与角色。可用用户名或邮箱登录；企业 SSO 后续接入（预留 source 字段）。"
        action={
          <button
            onClick={() => setShowForm((v) => !v)}
            className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
          >
            {showForm ? (
              "取消"
            ) : (
              <>
                <Plus size={15} /> 新建用户
              </>
            )}
          </button>
        }
      />

      {showForm && (
        <div className="mb-6">
          <Card title="新建用户">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="用户名"
                  value={f.username}
                  onChange={(x) => set("username", x)}
                  placeholder="如 zhangsan"
                />
                <Field
                  label="邮箱（登录标识/选填）"
                  value={f.email}
                  onChange={(x) => set("email", x)}
                  placeholder="zhangsan@corp.com"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="显示名（选填）"
                  value={f.displayName}
                  onChange={(x) => set("displayName", x)}
                  placeholder="张三"
                />
                <div>
                  <label className="label mb-1">初始密码</label>
                  <input
                    type="password"
                    value={f.password ?? ""}
                    onChange={(e) => set("password", e.target.value)}
                    placeholder="至少 8 位"
                    className="input"
                  />
                </div>
              </div>
              <div>
                <label className="label mb-1">角色</label>
                <div className="flex flex-wrap gap-2">
                  {roles.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => toggleRole(r.id)}
                      className={`rounded-full border px-3 py-1 text-xs transition ${
                        roleIds.includes(r.id)
                          ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                          : "border-slate-300 text-muted hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                      }`}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>
              {err && <p className="text-xs text-red-500">{err}</p>}
              <button
                onClick={add}
                disabled={create.isPending}
                className="btn btn-primary w-full"
              >
                {create.isPending ? "创建中…" : "创建用户"}
              </button>
            </div>
          </Card>
        </div>
      )}

      <div className="space-y-2">
        {users.length === 0 && <EmptyState>还没有用户。</EmptyState>}
        {users.map((u) => (
          <div
            key={u.id}
            className="card flex items-center gap-3 px-4 py-3.5 transition hover:border-indigo-200 dark:hover:border-indigo-500/30"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-indigo-600 text-sm font-semibold text-white">
              {(u.displayName || u.username).slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {u.displayName || u.username}
                </span>
                {u.status === "disabled" && (
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                    已停用
                  </span>
                )}
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {u.source}
                </span>
              </div>
              <div className="truncate text-xs text-muted">
                {u.username}
                {u.email ? ` · ${u.email}` : ""}
              </div>
            </div>
            <div className="hidden items-center gap-1 sm:flex">
              {u.roles.length === 0 && (
                <span className="text-[11px] text-muted">无角色</span>
              )}
              {u.roles.map((r) => (
                <span
                  key={r.id}
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                >
                  {r.name}
                </span>
              ))}
            </div>
            <button
              onClick={() => setEditing(u)}
              className="btn btn-ghost btn-sm"
            >
              编辑
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <UserEditModal
          user={editing}
          roles={roles}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function UserEditModal({
  user,
  roles,
  onClose,
}: {
  user: AdminUser;
  roles: { id: string; name: string }[];
  onClose: () => void;
}) {
  const { update, resetPassword, remove } = useAdminUserOps();
  const { confirm: askConfirm } = useFeedback();
  const [roleIds, setRoleIds] = useState<string[]>(user.roles.map((r) => r.id));
  const [newPw, setNewPw] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const disabled = user.status === "disabled";
  const toggleRole = (id: string) =>
    setRoleIds((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id],
    );

  async function saveRoles() {
    setErr("");
    setMsg("");
    try {
      await update.mutateAsync({ id: user.id, roleIds });
      setMsg("角色已保存");
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? errText(e));
    }
  }
  async function toggleStatus() {
    setErr("");
    setMsg("");
    try {
      await update.mutateAsync({
        id: user.id,
        status: disabled ? "active" : "disabled",
      });
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? errText(e));
    }
  }
  async function doReset() {
    setErr("");
    setMsg("");
    if (newPw.length < 8) return setErr("密码至少 8 位");
    try {
      await resetPassword.mutateAsync({ id: user.id, password: newPw });
      setNewPw("");
      setMsg("密码已重置");
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? errText(e));
    }
  }
  async function doDelete() {
    if (
      !(await askConfirm({
        title: "删除用户",
        message: `确认删除用户「${user.username}」？该操作不可恢复。`,
        confirmText: "删除用户",
        tone: "danger",
      }))
    )
      return;
    setErr("");
    try {
      await remove.mutateAsync(user.id);
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? errText(e));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card animate-fade-in w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold">编辑用户</h2>
        <p className="mb-4 text-xs text-muted">
          {user.username}
          {user.email ? ` · ${user.email}` : ""}
        </p>

        <label className="label mb-1">角色</label>
        <div className="mb-2 flex flex-wrap gap-2">
          {roles.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => toggleRole(r.id)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                roleIds.includes(r.id)
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                  : "border-slate-300 text-muted hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
              }`}
            >
              {r.name}
            </button>
          ))}
        </div>
        <button
          onClick={saveRoles}
          disabled={update.isPending}
          className="btn btn-primary btn-sm w-full"
        >
          保存角色
        </button>

        <div className="my-4 border-t border-slate-200 dark:border-slate-800" />

        <label className="label mb-1">重置密码</label>
        <div className="flex gap-2">
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="新密码（≥8 位）"
            className="input flex-1"
          />
          <button
            onClick={doReset}
            disabled={resetPassword.isPending}
            className="btn btn-ghost btn-sm inline-flex items-center gap-1.5"
          >
            <KeyRound size={14} /> 重置
          </button>
        </div>

        <div className="my-4 border-t border-slate-200 dark:border-slate-800" />

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={toggleStatus}
            disabled={update.isPending}
            className="btn btn-ghost btn-sm inline-flex items-center gap-1.5"
          >
            {disabled ? (
              <>
                <CheckCircle2 size={14} /> 启用
              </>
            ) : (
              <>
                <Ban size={14} /> 停用
              </>
            )}
          </button>
          <button
            onClick={doDelete}
            disabled={remove.isPending}
            className="btn btn-ghost btn-sm inline-flex items-center gap-1.5 text-red-500"
          >
            <Trash2 size={14} /> 删除
          </button>
        </div>

        {err && <p className="mt-3 text-xs text-red-500">{err}</p>}
        {msg && (
          <p className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">
            {msg}
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="btn btn-ghost btn-sm">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
