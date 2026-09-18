import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useModelConfigs, useModelConfigMutations } from "../../hooks/useModelConfigs";
import { PageHeader, EmptyState, Card, Field, errText } from "./ui";
import { Select } from "../common/Select";

const PLATFORMS = [
  { engine: "codex", name: "OpenAI · Codex", note: "使用个人 OpenAI Platform API Key，按 API 用量计费" },
  { engine: "claude-code", name: "Anthropic · Claude", note: "使用个人 Anthropic Console API Key，按 API 用量计费" },
  { engine: "deepseek-agent", name: "DeepSeek", note: "使用个人 DeepSeek API Key" },
  { engine: "glm-agent", name: "智谱 GLM", note: "使用个人智谱开放平台 API Key" },
] as const;

export function ModelsPage() {
  const { data: configs = [] } = useModelConfigs();
  const { create, setDefault, remove, updateKey } = useModelConfigMutations();
  const [showForm, setShowForm] = useState(false);
  const [engine, setEngine] = useState<string>(PLATFORMS[0].engine);
  const [label, setLabel] = useState<string>(PLATFORMS[0].name);
  const [apiKey, setApiKey] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replacementKey, setReplacementKey] = useState("");
  const platform = PLATFORMS.find((item) => item.engine === engine)!;

  async function save() {
    if (!label.trim() || !apiKey.trim()) return;
    await create.mutateAsync({ label: label.trim(), engine, apiKey: apiKey.trim() });
    setApiKey("");
    setShowForm(false);
  }

  return <div>
    <PageHeader title="AI 平台连接" desc="只连接平台和个人 API 凭证；具体模型在项目对话框中选择。API 调用不使用网页或客户端订阅额度。" action={
      <button className="btn btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => setShowForm((value) => !value)}>{showForm ? "取消" : <><Plus size={15}/>连接平台</>}</button>
    }/>
    {showForm && <div className="mb-6"><Card title="连接 AI 平台"><div className="space-y-3">
      <div><label className="label mb-1">平台</label><Select value={engine} onChange={(value) => { setEngine(value); setLabel(PLATFORMS.find((item) => item.engine === value)?.name || value); setApiKey(""); }} options={PLATFORMS.map((item) => ({ value: item.engine, label: item.name }))}/></div>
      <p className="text-xs text-muted">{platform.note}。Worker 通过智能体按需读取、编辑项目代码。</p>
      <Field label="连接名称" value={label} onChange={setLabel} placeholder="如 我的工作账号"/>
      <Field label="API Key" value={apiKey} onChange={setApiKey} placeholder="仅加密存储，不会回显" type="password"/>
      <button className="btn btn-primary w-full" disabled={create.isPending || !label.trim() || !apiKey.trim()} onClick={() => void save()}>{create.isPending ? "保存中…" : "保存连接"}</button>
      {create.isError && <p className="text-xs text-red-500">保存失败：{errText(create.error)}</p>}
    </div></Card></div>}
    <div className="space-y-2">
      {!configs.length && <EmptyState>尚未连接 AI 平台。请先添加个人 API 凭证，再到项目对话框选择模型。</EmptyState>}
      {configs.map((item) => <div key={item.id} className="card flex flex-wrap items-center gap-3 px-4 py-3.5">
        <input type="radio" name="default" checked={item.isDefault} onChange={() => setDefault.mutate(item.id)} title="设为默认平台" className="accent-indigo-600"/>
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{item.label}</span>{item.isDefault && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">默认</span>}</div><p className="truncate text-xs text-muted">{PLATFORMS.find((p) => p.engine === item.engine)?.name || item.provider} · {item.keyMasked}{item.model && !PLATFORMS.some((p) => p.engine === item.engine) ? ` · 旧配置模型 ${item.model}` : ""}</p></div>
        <button className="btn btn-ghost btn-sm" onClick={() => { setEditingId(editingId === item.id ? null : item.id); setReplacementKey(""); }}>更新 Key</button>
        <button className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10" title="删除" onClick={() => { if (window.confirm(`确定删除 ${item.label}？`)) remove.mutate(item.id); }}><Trash2 size={15}/></button>
        {editingId === item.id && <div className="flex w-full gap-2"><input className="input flex-1" type="password" autoComplete="off" value={replacementKey} onChange={(event) => setReplacementKey(event.target.value)} placeholder="输入新的个人 API Key"/><button className="btn btn-primary btn-sm" disabled={!replacementKey.trim() || updateKey.isPending} onClick={async () => { await updateKey.mutateAsync({ id: item.id, apiKey: replacementKey.trim() }); setReplacementKey(""); setEditingId(null); }}>保存</button></div>}
      </div>)}
    </div>
  </div>;
}
