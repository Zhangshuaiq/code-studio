import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  useModelConfigs,
  useModelConfigMutations,
} from "../../hooks/useModelConfigs";
import { PageHeader, EmptyState, Card, Field, errText } from "./ui";
import { Select } from "../common/Select";

// 常见「国内可直连 + 有免费额度」的 OpenAI 兼容平台预设，选了自动填 baseUrl/model
const PRESETS: { label: string; baseUrl: string; model: string }[] = [
  {
    label: "智谱 GLM-4.5-Flash（免费·推荐，代码强）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.5-flash",
  },
  {
    label: "Claude Sonnet（需 Anthropic API Key，最强之一）",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-6",
  },
  {
    label: "Claude Opus（需 Anthropic API Key，最强）",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-opus-4-8",
  },
  {
    label: "智谱 GLM-4-Flash（免费，较弱）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
  },
  {
    label: "通义千问 Qwen（免费额度）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-turbo",
  },
  {
    label: "DeepSeek（低价）",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  { label: "自定义", baseUrl: "", model: "" },
];

export function ModelsPage() {
  const { data: configs = [] } = useModelConfigs();
  const { create, setDefault, remove } = useModelConfigMutations();

  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [model, setModel] = useState(PRESETS[0].model);
  const [apiKey, setApiKey] = useState("");
  const [preset, setPreset] = useState("0");
  const [engine, setEngine] = useState("simple");

  function applyPreset(idx: string) {
    setPreset(idx);
    const p = PRESETS[Number(idx)];
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    if (!label) setLabel(p.label.replace(/（.*）/, ""));
  }

  async function handleAdd() {
    if (!label.trim() || !baseUrl.trim() || !model.trim() || !apiKey.trim())
      return;
    await create.mutateAsync({ label, engine, baseUrl, model, apiKey });
    setLabel("");
    setApiKey("");
    setShowForm(false);
  }

  return (
    <div>
      <PageHeader
        title="模型"
        desc="自带 API Key（BYOK），加密存储、不回显。可保存多套并切换默认。"
        action={
          <button
            onClick={() => setShowForm((v) => !v)}
            className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
          >
            {showForm ? (
              "取消"
            ) : (
              <>
                <Plus size={15} /> 添加模型
              </>
            )}
          </button>
        }
      />

      {showForm && (
        <div className="mb-6">
          <Card title="添加模型">
            <div className="space-y-3">
              <div>
                <label className="label mb-1">平台预设</label>
                <Select
                  value={preset}
                  onChange={applyPreset}
                  options={PRESETS.map((item, index) => ({
                    value: String(index),
                    label: item.label,
                  }))}
                />
              </div>
              <div>
                <label className="label mb-1">生成引擎</label>
                <Select
                  value={engine}
                  onChange={setEngine}
                  options={[
                    {
                      value: "simple",
                      label: "一把梭（simple，快，冷启动稳）",
                    },
                    {
                      value: "aider",
                      label: "智能体（aider，有记忆、增量修改更强）",
                    },
                  ]}
                />
              </div>
              <Field
                label="名称"
                value={label}
                onChange={setLabel}
                placeholder="如 我的 GLM"
              />
              <Field
                label="Base URL"
                value={baseUrl}
                onChange={setBaseUrl}
                placeholder="https://…/v1"
              />
              <Field
                label="模型"
                value={model}
                onChange={setModel}
                placeholder="glm-4-flash"
              />
              <Field
                label="API Key"
                value={apiKey}
                onChange={setApiKey}
                placeholder="仅加密存储，不会回显"
                type="password"
              />
              <button
                onClick={handleAdd}
                disabled={create.isPending}
                className="btn btn-primary w-full"
              >
                {create.isPending ? "保存中…" : "保存"}
              </button>
              {create.isError && (
                <p className="text-xs text-red-500">
                  保存失败：{errText(create.error)}
                </p>
              )}
            </div>
          </Card>
        </div>
      )}

      <div className="space-y-2">
        {configs.length === 0 && (
          <EmptyState>
            还没有模型配置。生成前请先添加一套你自己的 API Key（BYOK）。
          </EmptyState>
        )}
        {configs.map((c) => (
          <div
            key={c.id}
            className="card flex items-center gap-3 px-4 py-3.5 transition hover:border-indigo-200 dark:hover:border-indigo-500/30"
          >
            <input
              type="radio"
              name="default"
              checked={c.isDefault}
              onChange={() => setDefault.mutate(c.id)}
              title="设为默认"
              className="accent-indigo-600"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{c.label}</span>
                {c.isDefault && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                    默认
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-muted">
                {c.model} · {c.engine === "aider" ? "智能体" : "一把梭"} ·{" "}
                {c.keyMasked}
              </div>
            </div>
            <button
              onClick={() => remove.mutate(c.id)}
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
