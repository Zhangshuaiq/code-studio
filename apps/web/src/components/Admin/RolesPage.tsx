import { useState } from "react";
import { Plus, Trash2, Lock } from "lucide-react";
import {
  AdminRole,
  PermissionItem,
  useAdminRoles,
  usePermissionCatalog,
  useAdminRoleOps,
} from "../../hooks/useAdmin";
import { PageHeader, EmptyState, Card, Field, errText } from "../Settings/ui";
import { useFeedback } from "../common/FeedbackProvider";

export function RolesPage() {
  const { data: roles = [] } = useAdminRoles();
  const { data: catalog = [] } = usePermissionCatalog();
  const { create } = useAdminRoleOps();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [perms, setPerms] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<AdminRole | null>(null);
  const toggle = (k: string) =>
    setPerms((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  async function add() {
    setErr("");
    if (!name.trim()) return setErr("角色名必填");
    try {
      await create.mutateAsync({
        name: name.trim(),
        description: desc.trim() || undefined,
        permissions: perms,
      });
      setName("");
      setDesc("");
      setPerms([]);
      setShowForm(false);
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? errText(e));
    }
  }

  const labelOf = (k: string) => catalog.find((c) => c.key === k)?.label ?? k;

  return (
    <div>
      <PageHeader
        title="角色"
        desc="角色 = 一组权限；用户可分配多个角色。内置角色由系统维护，可新建自定义角色。"
        action={
          <button
            onClick={() => setShowForm((v) => !v)}
            className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
          >
            {showForm ? (
              "取消"
            ) : (
              <>
                <Plus size={15} /> 新建角色
              </>
            )}
          </button>
        }
      />

      {showForm && (
        <div className="mb-6">
          <Card title="新建自定义角色">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="角色名"
                  value={name}
                  onChange={setName}
                  placeholder="如 ops"
                />
                <Field
                  label="描述（选填）"
                  value={desc}
                  onChange={setDesc}
                  placeholder="运维"
                />
              </div>
              <PermissionPicker
                catalog={catalog}
                selected={perms}
                onToggle={toggle}
              />
              {err && <p className="text-xs text-red-500">{err}</p>}
              <button
                onClick={add}
                disabled={create.isPending}
                className="btn btn-primary w-full"
              >
                {create.isPending ? "创建中…" : "创建角色"}
              </button>
            </div>
          </Card>
        </div>
      )}

      <div className="space-y-2">
        {roles.length === 0 && <EmptyState>还没有角色。</EmptyState>}
        {roles.map((r) => (
          <div
            key={r.id}
            className="card px-4 py-3.5 transition hover:border-indigo-200 dark:hover:border-indigo-500/30"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{r.name}</span>
              {r.builtin && (
                <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  <Lock size={10} /> 内置
                </span>
              )}
              <span className="text-[11px] text-muted">
                · {r.userCount} 个用户 · {r.permissions.length} 项权限
              </span>
              <div className="ml-auto">
                {!r.builtin && (
                  <button
                    onClick={() => setEditing(r)}
                    className="btn btn-ghost btn-sm"
                  >
                    编辑
                  </button>
                )}
              </div>
            </div>
            {r.description && (
              <p className="mt-0.5 text-xs text-muted">{r.description}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.permissions.map((p) => (
                <span
                  key={p}
                  className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                >
                  {labelOf(p)}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <RoleEditModal
          role={editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function PermissionPicker({
  catalog,
  selected,
  onToggle,
}: {
  catalog: PermissionItem[];
  selected: string[];
  onToggle: (k: string) => void;
}) {
  return (
    <div>
      <label className="label mb-1">权限</label>
      <div className="grid grid-cols-2 gap-1.5">
        {catalog.map((c) => (
          <label key={c.key} className="choice-row text-xs">
            <input
              type="checkbox"
              checked={selected.includes(c.key)}
              onChange={() => onToggle(c.key)}
            />
            <span className="truncate" title={c.key}>
              {c.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function RoleEditModal({
  role,
  catalog,
  onClose,
}: {
  role: AdminRole;
  catalog: PermissionItem[];
  onClose: () => void;
}) {
  const { update, remove } = useAdminRoleOps();
  const { confirm: askConfirm } = useFeedback();
  const [perms, setPerms] = useState<string[]>(role.permissions);
  const [err, setErr] = useState("");
  const toggle = (k: string) =>
    setPerms((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  async function save() {
    setErr("");
    try {
      await update.mutateAsync({ id: role.id, permissions: perms });
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? errText(e));
    }
  }
  async function doDelete() {
    if (
      !(await askConfirm({
        title: "删除角色",
        message: `确认删除角色「${role.name}」？`,
        confirmText: "删除角色",
        tone: "danger",
      }))
    )
      return;
    setErr("");
    try {
      await remove.mutateAsync(role.id);
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
        <h2 className="mb-4 text-base font-semibold">编辑角色 · {role.name}</h2>
        <PermissionPicker
          catalog={catalog}
          selected={perms}
          onToggle={toggle}
        />
        {err && <p className="mt-3 text-xs text-red-500">{err}</p>}
        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={doDelete}
            disabled={remove.isPending}
            className="btn btn-ghost btn-sm inline-flex items-center gap-1.5 text-red-500"
          >
            <Trash2 size={14} /> 删除角色
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn btn-ghost btn-sm">
              取消
            </button>
            <button
              onClick={save}
              disabled={update.isPending}
              className="btn btn-primary btn-sm"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
