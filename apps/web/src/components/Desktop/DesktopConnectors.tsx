import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Database,
  LoaderCircle,
  Network,
  Plus,
  TestTube2,
  Trash2,
} from "lucide-react";
import { Select } from "../common/Select";

export type ConnectorType = "postgres" | "mysql" | "kafka" | "kubernetes";
interface Connector {
  id: string;
  name: string;
  type: ConnectorType;
  settings: Record<string, any>;
  hasCredential: boolean;
}
const TYPES: Array<{ value: ConnectorType; label: string }> = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "kafka", label: "Apache Kafka" },
  { value: "kubernetes", label: "Kubernetes" },
];

export function DesktopConnectors({
  onClose,
  embedded = false,
  types = TYPES.map((item) => item.value),
  title = "数据与集群连接",
  subtitle = "数据库、Kafka 与 Kubernetes",
}: {
  onClose?: () => void;
  embedded?: boolean;
  types?: ConnectorType[];
  title?: string;
  subtitle?: string;
}) {
  const [items, setItems] = useState<Connector[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string>();
  const [sql, setSql] = useState("SELECT 1");
  const [explorer, setExplorer] = useState<any>();
  const [form, setForm] = useState({
    name: "",
    type: "postgres" as ConnectorType,
    host: "127.0.0.1",
    port: "5432",
    database: "",
    username: "",
    secret: "",
    brokers: "127.0.0.1:9092",
    clientId: "code-studio",
    server: "https://127.0.0.1:6443",
    namespace: "default",
    ssl: false,
  });
  async function load() {
    const response = await fetch("/api/local/connectors");
    const body = await response.json();
    if (response.ok)
      setItems(
        body.items.filter((item: Connector) => types.includes(item.type)),
      );
  }
  useEffect(() => {
    setForm((current) =>
      types.includes(current.type) ? current : { ...current, type: types[0] },
    );
    void load();
  }, [types.join(",")]);
  function changeType(type: ConnectorType) {
    setForm((current) => ({
      ...current,
      type,
      port:
        type === "postgres" ? "5432" : type === "mysql" ? "3306" : current.port,
    }));
  }
  async function save() {
    setBusy("save");
    setError("");
    const settings =
      form.type === "kafka"
        ? {
            brokers: form.brokers.split(","),
            clientId: form.clientId,
            username: form.username,
            ssl: form.ssl,
          }
        : form.type === "kubernetes"
          ? { server: form.server, namespace: form.namespace }
          : {
              host: form.host,
              port: Number(form.port),
              database: form.database,
              username: form.username,
              ssl: form.ssl,
            };
    try {
      const response = await fetch("/api/local/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          settings,
          secret: form.secret || undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message);
      await load();
      setShowForm(false);
      setForm((current) => ({ ...current, name: "", secret: "" }));
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setBusy("");
    }
  }
  async function test(item: Connector) {
    setBusy(item.id);
    setResult((current) => ({ ...current, [item.id]: "" }));
    const response = await fetch(`/api/local/connectors/${item.id}/test`, {
      method: "POST",
    });
    const body = await response.json();
    setResult((current) => ({
      ...current,
      [item.id]: response.ok
        ? `连接成功 · ${body.latencyMs} ms`
        : body.message || "连接失败",
    }));
    setBusy("");
  }
  async function remove(item: Connector) {
    if (!window.confirm(`确定删除“${item.name}”吗？`)) return;
    await fetch(`/api/local/connectors/${item.id}`, { method: "DELETE" });
    await load();
  }
  async function explore(item: Connector) {
    setBusy(`explore:${item.id}`);
    setError("");
    setActive(item.id);
    setExplorer(undefined);
    try {
      const response = await fetch(`/api/local/connectors/${item.id}/explore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message);
      setExplorer(body);
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setBusy("");
    }
  }
  const content = (
    <div
      className={
        embedded
          ? "flex h-full min-h-0 flex-col rounded-[22px] border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
          : "h-fit max-h-[88vh] w-full max-w-4xl overflow-auto rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      }
    >
      <header className="flex items-center border-b border-slate-200 px-5 py-4 dark:border-slate-700">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold">{title}</h2>
          <p className="mt-1 text-[11px] text-slate-400">{subtitle}</p>
        </div>
        <button
          className="btn btn-primary btn-sm mr-2"
          onClick={() => setShowForm((value) => !value)}
        >
          {showForm ? (
            "取消"
          ) : (
            <>
              <Plus size={14} />
              添加
            </>
          )}
        </button>
        {!embedded && (
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        )}
      </header>
      <div
        className={`space-y-4 overflow-auto ${embedded ? "min-h-0 flex-1 p-5" : "p-6"}`}
      >
        {showForm && (
          <section className="rounded-2xl border border-slate-200 p-5 dark:border-slate-700">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="连接名称"
                value={form.name}
                onChange={(value) =>
                  setForm((current) => ({ ...current, name: value }))
                }
              />
              <label className="text-[11px]">
                <span className="mb-1 block text-slate-500">类型</span>
                <Select
                  className="w-full"
                  value={form.type}
                  onChange={(value) => changeType(value as ConnectorType)}
                  options={TYPES.filter((item) => types.includes(item.value)).map((item) => ({ value: item.value, label: item.label }))}
                />
              </label>
              {form.type === "kafka" ? (
                <>
                  <Field
                    label="Broker 地址（逗号分隔）"
                    value={form.brokers}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, brokers: value }))
                    }
                  />
                  <Field
                    label="Client ID"
                    value={form.clientId}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, clientId: value }))
                    }
                  />
                  <Field
                    label="用户名（可选）"
                    value={form.username}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, username: value }))
                    }
                  />
                  <Field
                    label="密码（可选）"
                    type="password"
                    value={form.secret}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, secret: value }))
                    }
                  />
                </>
              ) : form.type === "kubernetes" ? (
                <>
                  <Field
                    label="集群地址"
                    value={form.server}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, server: value }))
                    }
                  />
                  <Field
                    label="命名空间"
                    value={form.namespace}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, namespace: value }))
                    }
                  />
                  <Field
                    label="访问令牌（可选）"
                    type="password"
                    value={form.secret}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, secret: value }))
                    }
                  />
                </>
              ) : (
                <>
                  <Field
                    label="主机"
                    value={form.host}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, host: value }))
                    }
                  />
                  <Field
                    label="端口"
                    value={form.port}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, port: value }))
                    }
                  />
                  <Field
                    label="数据库"
                    value={form.database}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, database: value }))
                    }
                  />
                  <Field
                    label="用户名"
                    value={form.username}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, username: value }))
                    }
                  />
                  <Field
                    label="密码（可选）"
                    type="password"
                    value={form.secret}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, secret: value }))
                    }
                  />
                </>
              )}
              <label className="flex items-center gap-2 self-end py-2 text-xs">
                <input
                  type="checkbox"
                  checked={form.ssl}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      ssl: event.target.checked,
                    }))
                  }
                />
                使用 TLS
              </label>
            </div>
            <button
              className="btn btn-primary mt-4 w-full"
              disabled={busy === "save" || !form.name.trim()}
              onClick={() => void save()}
            >
              {busy === "save" ? (
                <LoaderCircle size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              保存连接
            </button>
            {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
          </section>
        )}
        <section className="space-y-2">
          {items.length ? (
            items.map((item) => (
              <div
                key={item.id}
                className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700"
              >
                <div className="flex flex-wrap items-center gap-2 px-3 py-3">
                  {item.type === "kubernetes" || item.type === "kafka" ? (
                    <Network size={16} className="text-violet-500" />
                  ) : (
                    <Database size={16} className="text-indigo-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{item.name}</div>
                    <div className="truncate text-[10px] text-slate-400">
                      {TYPES.find((type) => type.value === item.type)?.label}
                      {item.hasCredential ? " · 凭据已保护" : ""}
                    </div>
                    {result[item.id] && (
                      <div
                        className={`mt-1 text-[10px] ${result[item.id].startsWith("连接成功") ? "text-emerald-500" : "text-red-500"}`}
                      >
                        {result[item.id]}
                      </div>
                    )}
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy === item.id}
                    onClick={() => void test(item)}
                  >
                    {busy === item.id ? (
                      <LoaderCircle size={13} className="animate-spin" />
                    ) : (
                      <TestTube2 size={13} />
                    )}
                    测试
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (active === item.id) {
                        setActive(undefined);
                        return;
                      }
                      if (item.type === 'postgres' || item.type === 'mysql') {
                        setActive(item.id); setExplorer(undefined); setSql('SELECT 1');
                      } else void explore(item);
                    }}
                  >
                    {busy === `explore:${item.id}` ? (
                      <LoaderCircle size={13} className="animate-spin" />
                    ) : null}
                    {active === item.id
                      ? "收起"
                      : item.type === "kafka"
                        ? "Topics"
                        : item.type === "kubernetes"
                          ? "Pods"
                          : "查询"}
                  </button>
                  <button
                    className="icon-btn text-red-500"
                    onClick={() => void remove(item)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {active === item.id && (
                  <div className="border-t border-slate-200 p-3 dark:border-slate-700">
                    {(item.type === "postgres" || item.type === "mysql") && (
                      <div className="mb-2 flex gap-2">
                        <textarea
                          value={sql}
                          onChange={(event) => setSql(event.target.value)}
                          className="input min-h-20 min-w-0 flex-1 resize-y font-mono text-[11px]"
                        />
                        <button
                          className="btn btn-primary btn-sm self-end"
                          disabled={Boolean(busy) || !sql.trim()}
                          onClick={() => void explore(item)}
                        >
                          执行
                        </button>
                      </div>
                    )}
                    <ConnectorResult value={explorer} />
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-dashed p-8 text-center text-xs text-slate-400">
              <CheckCircle2 size={20} className="mx-auto mb-2" />
              尚未添加连接
            </div>
          )}
        </section>
      </div>
    </div>
  );
  if (embedded) return content;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-center overflow-auto bg-slate-950/50 px-5 py-10"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      {content}
    </div>
  );
}

function Field({
  label,
  value,
  type = "text",
  onChange,
}: {
  label: string;
  value: string;
  type?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-[11px]">
      <span className="mb-1 block text-slate-500">{label}</span>
      <input
        className="input w-full"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={type === "password" ? "new-password" : undefined}
      />
    </label>
  );
}

function ConnectorResult({ value }: { value: any }) {
  if (!value) return <p className="text-[10px] text-slate-400">暂无结果</p>;
  if (value.kind === 'command') return <p className="text-xs text-emerald-600" role="status">执行成功 · 影响 {value.affectedRows ?? 0} 行{value.insertId ? ` · 新增 ID ${value.insertId}` : ''}</p>;
  if (value.kind === "table")
    return (
      <div className="max-h-64 overflow-auto">
        <table className="min-w-full border-collapse font-mono text-[10px]">
          <thead>
            <tr>
              {value.columns.map((column: string) => (
                <th
                  key={column}
                  className="sticky top-0 border bg-slate-100 px-2 py-1 text-left dark:bg-slate-800"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.rows.map((row: any, index: number) => (
              <tr key={index}>
                {value.columns.map((column: string) => (
                  <td
                    key={column}
                    className="max-w-52 truncate border px-2 py-1"
                  >
                    {typeof row[column] === "object"
                      ? JSON.stringify(row[column])
                      : String(row[column] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {value.truncated && (
          <p className="py-2 text-[10px] text-amber-500">仅显示前 500 行</p>
        )}
      </div>
    );
  const items = value.items || [];
  return (
    <div className="max-h-64 space-y-1 overflow-auto">
      {items.map((item: any, index: number) => (
        <div
          key={typeof item === "string" ? item : item.name || index}
          className="rounded bg-slate-100 px-2 py-1 font-mono text-[10px] dark:bg-slate-800"
        >
          {typeof item === "string"
            ? item
            : `${item.name} · ${item.phase || ""}${item.node ? ` · ${item.node}` : ""}`}
        </div>
      ))}
      {!items.length && (
        <p className="text-[10px] text-slate-400">没有可显示的资源</p>
      )}
    </div>
  );
}
