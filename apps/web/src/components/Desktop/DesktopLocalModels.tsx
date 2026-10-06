import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Gauge,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { Select } from "../common/Select";

interface LocalModel {
  id: string;
  name: string;
  engine: string;
  provider: string;
  baseUrl?: string;
  model: string;
  executionLocation: "local";
  hasCredential: boolean;
}
interface AgentDiscovery {
  engine: string;
  command: string;
  available: boolean;
  version?: string | null;
}
interface CodexModel { id: string; name: string; description: string; defaultReasoningEffort: string; reasoningEfforts: { value: string; description: string }[]; contextWindow?: number | null }
interface ModelUsage { model: string; tasks: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number }

const ENGINE_LABELS: Record<string, string> = {
  "codex-cli": "OpenAI · Codex CLI",
  "claude-code": "Anthropic · Claude Code",
  aider: "Aider",
  "openai-compatible": "OpenAI-compatible",
  ollama: "Ollama / LM Studio",
};
const ENGINE_NOTES: Record<string, string> = {
  "codex-cli": "使用当前设备已登录的 Codex 账号。",
  "claude-code": "使用当前设备已登录的 Claude Code 账号。",
  aider: "使用 Aider 连接兼容 OpenAI 的模型服务。",
  "openai-compatible":
    "适用于兼容 OpenAI Chat Completions 的自建或第三方服务。",
  ollama: "连接 Ollama 或 LM Studio 中已经下载的模型。",
};

export function DesktopLocalModels({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const [models, setModels] = useState<LocalModel[]>([]);
  const [discovery, setDiscovery] = useState<AgentDiscovery[]>([]);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [usage, setUsage] = useState<ModelUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState("");
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    engine: "codex-cli",
    provider: "openai",
    baseUrl: "",
    model: "",
    apiKey: "",
  });

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [modelsResponse, discoveryResponse, catalogResponse, usageResponse] = await Promise.all([
        fetch("/api/local/models"),
        fetch("/api/local/models/discover"),
        fetch("/api/local/models/catalog?engine=codex-cli"),
        fetch("/api/local/models/usage"),
      ]);
      const modelsBody = await modelsResponse.json();
      const discoveryBody = await discoveryResponse.json();
      const catalogBody = await catalogResponse.json();
      const usageBody = await usageResponse.json();
      if (!modelsResponse.ok)
        throw new Error(modelsBody.message || `HTTP ${modelsResponse.status}`);
      if (!discoveryResponse.ok)
        throw new Error(
          discoveryBody.message || `HTTP ${discoveryResponse.status}`,
        );
      setModels(modelsBody.items);
      setDiscovery(discoveryBody.items);
      setCodexModels(catalogResponse.ok ? catalogBody.items || [] : []);
      setUsage(usageResponse.ok ? usageBody.items || [] : []);
      if (catalogResponse.ok && catalogBody.items?.length) setForm((current) => current.engine === "codex-cli" && !current.model ? { ...current, model: catalogBody.items[0].id } : current);
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function createModel() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/local/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          name: form.name.trim() || ENGINE_LABELS[form.engine],
          apiKey: form.apiKey || undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message || `HTTP ${response.status}`);
      setModels((items) => [body, ...items]);
      setForm((value) => ({ ...value, name: "", model: "", apiKey: "" }));
      setShowForm(false);
    } catch (reason: any) {
      setError(String(reason?.message || reason));
    } finally {
      setSaving(false);
    }
  }

  async function removeModel(id: string) {
    if (!window.confirm("确定删除这个模型连接吗？保存的凭据也会一并移除。"))
      return;
    const response = await fetch(`/api/local/models/${id}`, {
      method: "DELETE",
    });
    if (response.ok)
      setModels((items) => items.filter((item) => item.id !== id));
  }

  async function testModel(id: string) {
    setTestingId(id); setError("");
    try {
      const response = await fetch(`/api/local/models/${id}/test`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      const missingModel = body.configuredModelAvailable === false;
      const detail = body.kind === "cli" ? "账号登录状态正常" : missingModel ? `连接正常，但服务端未返回当前配置的模型（${body.latencyMs} ms）` : `${body.latencyMs} ms${Array.isArray(body.models) ? ` · 发现 ${body.models.length} 个模型` : ""}`;
      setTestResults((items) => ({ ...items, [id]: { ok: !missingModel, message: detail } }));
    } catch (reason: any) {
      setTestResults((items) => ({ ...items, [id]: { ok: false, message: String(reason?.message || reason) } }));
    } finally { setTestingId(""); }
  }

  const needsEndpoint = ["aider", "openai-compatible", "ollama"].includes(
    form.engine,
  );
  const acceptsKey = ["aider", "openai-compatible"].includes(form.engine);
  return (
    <div
      className={embedded ? "h-full min-h-0" : "fixed inset-0 z-50 flex justify-center overflow-auto bg-slate-950/50 px-5 py-10"}
      onMouseDown={(event) => {
        if (!embedded && event.target === event.currentTarget) onClose?.();
      }}
    >
      <div className={embedded ? "h-full w-full overflow-auto rounded-[22px] border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" : "h-fit max-h-[88vh] w-full max-w-4xl overflow-auto rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"}>
        <header className="flex items-center border-b border-slate-200 px-6 py-4 dark:border-slate-700">
          <div className="flex-1">
            <h2 className="text-base font-bold">AI 平台连接</h2>
            <p className="mt-1 text-[11px] text-slate-400">
              管理用于智能助手的账号与模型服务。
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm mr-2"
            onClick={() => setShowForm((value) => !value)}
          >
            {showForm ? (
              "取消"
            ) : (
              <>
                <Plus size={14} />
                连接平台
              </>
            )}
          </button>
          {!embedded && <button type="button" className="icon-btn" onClick={onClose}>×</button>}
        </header>
        <div className="space-y-6 p-6">
          {showForm && (
            <section className="rounded-2xl border border-slate-200 p-5 dark:border-slate-700">
              <h3 className="text-sm font-bold">连接 AI 平台</h3>
              <div className="mt-4 space-y-3">
                <label className="block text-[11px]">
                  <span className="mb-1 block text-slate-500">平台</span>
                  <Select
                    className="w-full"
                    value={form.engine}
                    options={Object.entries(ENGINE_LABELS).map(([value, label]) => ({ value, label }))}
                    onChange={(engine) =>
                      setForm((value) => ({
                        ...value,
                        engine,
                        provider:
                          engine === "openai-compatible"
                            ? "custom"
                            : engine,
                        baseUrl:
                          engine === "ollama"
                            ? "http://127.0.0.1:11434/v1"
                            : "",
                        model: engine === "codex-cli" ? codexModels[0]?.id || "" : "",
                      }))
                    }
                  />
                </label>
                <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-950/60">
                  {ENGINE_NOTES[form.engine]}
                </p>
                <label className="block text-[11px]">
                  <span className="mb-1 block text-slate-500">连接名称</span>
                  <input
                    className="input w-full"
                    value={form.name}
                    onChange={(event) =>
                      setForm((value) => ({
                        ...value,
                        name: event.target.value,
                      }))
                    }
                    placeholder={ENGINE_LABELS[form.engine]}
                  />
                </label>
                <label className="block text-[11px]">
                  <span className="mb-1 block text-slate-500">
                    {form.engine === "codex-cli" ? "Codex 模型" : "模型标识"}
                  </span>
                  {form.engine === "codex-cli" && codexModels.length ? <Select className="w-full" value={form.model} placeholder="选择具体模型" options={codexModels.map((item) => ({ value: item.id, label: `${item.name} · ${item.defaultReasoningEffort}` }))} onChange={(model) => setForm((value) => ({ ...value, model }))} /> : <input className="input w-full" value={form.model} onChange={(event) => setForm((value) => ({ ...value, model: event.target.value }))} placeholder="例如 qwen2.5-coder" />}
                  {form.engine === "codex-cli" && <span className="mt-1 block text-[10px] text-slate-400">目录来自本机 Codex CLI；还可在每次对话发送前切换模型和推理强度。</span>}
                </label>
                {needsEndpoint && (
                  <label className="block text-[11px]">
                    <span className="mb-1 block text-slate-500">
                      API Base URL
                    </span>
                    <input
                      className="input w-full"
                      value={form.baseUrl}
                      onChange={(event) =>
                        setForm((value) => ({
                          ...value,
                          baseUrl: event.target.value,
                        }))
                      }
                      placeholder="http://127.0.0.1:11434/v1"
                    />
                  </label>
                )}
                {acceptsKey && (
                  <label className="block text-[11px]">
                    <span className="mb-1 block text-slate-500">
                      API Key（安全保存且不会回显）
                    </span>
                    <input
                      type="password"
                      className="input w-full"
                      value={form.apiKey}
                      onChange={(event) =>
                        setForm((value) => ({
                          ...value,
                          apiKey: event.target.value,
                        }))
                      }
                      autoComplete="new-password"
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="btn btn-primary w-full"
                  disabled={saving || (form.engine === "codex-cli" && !form.model)}
                  onClick={() => void createModel()}
                >
                  {saving ? (
                    <LoaderCircle size={14} className="animate-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                  保存连接
                </button>
              </div>
            </section>
          )}
          {error && (
            <p className="rounded-lg bg-red-50 p-3 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </p>
          )}
          <section>
            <div className="mb-3 flex items-center">
              <h3 className="flex-1 text-xs font-bold">可用工具</h3>
              <button
                type="button"
                className="icon-btn"
                onClick={() => void load()}
                disabled={loading}
              >
                <RefreshCw
                  size={13}
                  className={loading ? "animate-spin" : ""}
                />
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {discovery.map((item) => (
                <div
                  key={item.engine}
                  className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"
                >
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    {item.available ? (
                      <CheckCircle2 size={14} className="text-emerald-500" />
                    ) : (
                      <XCircle size={14} className="text-slate-400" />
                    )}
                    {ENGINE_LABELS[item.engine] || item.engine}
                  </div>
                  <div className="mt-1 truncate text-[10px] text-slate-400">
                    {item.available ? item.version || "可用" : "尚未安装"}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section>
            <div className="mb-3 flex items-center gap-2"><Gauge size={14} className="text-indigo-500"/><h3 className="text-xs font-bold">本机额度消耗</h3></div>
            {usage.length ? <div className="grid gap-2 sm:grid-cols-2">{usage.map((item) => <div key={item.model} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div className="truncate text-xs font-semibold">{item.model === "default" ? "默认模型" : item.model}</div><div className="mt-2 text-lg font-bold tabular-nums">{formatTokens(item.totalTokens)} <span className="text-[10px] font-normal text-slate-400">tokens</span></div><div className="mt-1 text-[10px] text-slate-400">输入 {formatTokens(item.inputTokens)} · 缓存 {formatTokens(item.cachedInputTokens)} · 输出 {formatTokens(item.outputTokens)} · {item.tasks} 次任务</div></div>)}</div> : <div className="rounded-xl border border-dashed p-5 text-center text-xs text-slate-400">完成一次对话后，这里会按模型汇总实际 token 消耗。</div>}
            <p className="mt-2 text-[10px] text-slate-400">这是客户端从任务结果记录的实际消耗；Codex CLI 当前未提供稳定的订阅剩余额度接口。</p>
          </section>
          <section>
            <h3 className="mb-3 text-xs font-bold">已连接平台</h3>
            {models.length ? (
              <div className="space-y-2">
                {models.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3.5 dark:border-slate-700"
                  >
                    <Cpu size={16} className="shrink-0 text-indigo-500" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {model.name}
                      </div>
                      <div className="mt-1 flex items-center gap-1 truncate text-[11px] text-slate-400">
                        {ENGINE_LABELS[model.engine] || model.engine}
                        {model.model ? ` · ${model.model}` : ""}
                        {model.hasCredential && (
                          <>
                            <span> · </span>
                            <ShieldCheck size={11} />
                            凭据已保护
                          </>
                        )}
                      </div>
                      {testResults[model.id] && <div className={`mt-1 text-[10px] ${testResults[model.id].ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>{testResults[model.id].message}</div>}
                    </div>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={testingId === model.id} onClick={() => void testModel(model.id)}>{testingId === model.id ? <LoaderCircle size={13} className="animate-spin" /> : <RefreshCw size={13} />}测试</button>
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                      title="删除"
                      onClick={() => void removeModel(model.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed p-8 text-center text-xs text-slate-400">
                尚未连接 AI 平台。
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function formatTokens(value: number) { return new Intl.NumberFormat("zh-CN", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0); }
