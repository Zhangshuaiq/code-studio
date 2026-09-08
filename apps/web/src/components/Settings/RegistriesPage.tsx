import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useRegistries, useRegistryOps } from "../../hooks/useDeploy";
import { PageHeader, EmptyState, Card, Field, errText } from "./ui";

// 镜像仓库（独立可插拔资源）。registry-agnostic：Harbor / 阿里云 ACR / Docker Hub / 自建 registry:2 同一套。
export function RegistriesPage() {
  const { data: registries = [] } = useRegistries();
  const { create, remove } = useRegistryOps();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [f, setF] = useState<Record<string, string>>({});
  const [insecure, setInsecure] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function add() {
    setErr("");
    if (!name.trim()) return setErr("请填写名称（备注）");
    if (!f.url || !f.username || !f.password)
      return setErr("请填写仓库地址 / 用户名 / 密码");
    try {
      await create.mutateAsync({
        name: name.trim(),
        config: {
          url: f.url,
          project: f.project || undefined,
          username: f.username,
          password: f.password,
          insecure,
        },
      });
      setName("");
      setF({});
      setInsecure(false);
      setShowForm(false);
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? errText(e));
    }
  }

  return (
    <div>
      <PageHeader
        title="镜像仓库"
        desc="独立可插拔资源，供 k8s 部署推送镜像。走标准 Docker Registry v2，任意仓库通用；凭证加密存储。"
        action={
          <button
            onClick={() => setShowForm((v) => !v)}
            className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
          >
            {showForm ? (
              "取消"
            ) : (
              <>
                <Plus size={15} /> 添加仓库
              </>
            )}
          </button>
        }
      />

      {showForm && (
        <div className="mb-6">
          <Card title="添加仓库">
            <div className="space-y-3">
              <Field
                label="名称（备注）"
                value={name}
                onChange={setName}
                placeholder="如 公司 Harbor / 阿里云 ACR"
              />
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <Field
                    label="仓库地址"
                    value={f.url}
                    onChange={(x) => set("url", x)}
                    placeholder="harbor.mycorp.com"
                  />
                </div>
                <Field
                  label="project(可选)"
                  value={f.project}
                  onChange={(x) => set("project", x)}
                  placeholder="codegen"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="用户名"
                  value={f.username}
                  onChange={(x) => set("username", x)}
                  placeholder="robot$codegen"
                />
                <div>
                  <label className="label mb-1">密码 / Token</label>
                  <input
                    type="password"
                    value={f.password ?? ""}
                    onChange={(e) => set("password", e.target.value)}
                    placeholder="••••••"
                    className="input"
                  />
                </div>
              </div>
              <label className="choice-row text-xs">
                <input
                  type="checkbox"
                  checked={insecure}
                  onChange={(e) => setInsecure(e.target.checked)}
                />
                insecure（http / 自签证书，如本地 registry:2）
              </label>
              <p className="text-[11px] text-muted">
                Harbor 建议用限定到某 project 的 <b>robot account</b>
                ，权限最小化。
              </p>
              {err && <p className="text-xs text-red-500">{err}</p>}
              <button
                onClick={add}
                disabled={create.isPending}
                className="btn btn-primary w-full"
              >
                {create.isPending ? "保存中…" : "保存仓库"}
              </button>
            </div>
          </Card>
        </div>
      )}

      <div className="space-y-2">
        {registries.length === 0 && (
          <EmptyState>
            还没有镜像仓库。远程 k8s 集群部署需要一个能被集群拉取的仓库。
          </EmptyState>
        )}
        {registries.map((r) => (
          <div
            key={r.id}
            className="card flex items-center gap-3 px-4 py-3.5 transition hover:border-indigo-200 dark:hover:border-indigo-500/30"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r.name}</div>
              <div className="truncate text-xs text-muted">{r.summary}</div>
            </div>
            <button
              onClick={() => remove.mutate(r.id)}
              title="删除"
              className="rounded-md p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
