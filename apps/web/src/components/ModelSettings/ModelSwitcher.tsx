import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useModelConfigs } from "../../hooks/useModelConfigs";
import { Select } from "../common/Select";

export function ModelSwitcher({ sessionId, initialConfigId, initialModelName, disabled, onReady }: {
  sessionId?: string;
  initialConfigId?: string | null;
  initialModelName?: string | null;
  disabled?: boolean;
  onReady?: (ready: boolean) => void;
}) {
  const { data: configs = [] } = useModelConfigs();
  const [configId, setConfigId] = useState("");
  const [modelName, setModelName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualModel, setManualModel] = useState("");

  useEffect(() => {
    if (!configs.length) return;
    const id = initialConfigId && configs.some((item) => item.id === initialConfigId)
      ? initialConfigId : (configs.find((item) => item.isDefault) || configs[0]).id;
    setConfigId(id);
    setModelName(initialConfigId === id ? initialModelName || "" : "");
  }, [sessionId, initialConfigId, initialModelName, configs]);

  const models = useQuery<{ models: { id: string; name: string; isDefault?: boolean }[]; source: string; defaultModel?: string | null }>({
    queryKey: ["config-models", configId],
    enabled: !!configId && !!sessionId,
    staleTime: 60_000,
    queryFn: async () => (await api.get(`/model-configs/${configId}/models`)).data,
  });
  const selectedConfig = configs.find((item) => item.id === configId);
  const cliMode = selectedConfig?.engine === "codex-cli";
  const cliDefault = cliMode ? models.data?.defaultModel : undefined;
  const cliDefaultName = models.data?.models.find((item) => item.id === cliDefault)?.name || cliDefault;
  const cliAccount = useQuery<{ connected: boolean }>({
    queryKey: ["codex-account"],
    enabled: cliMode,
    queryFn: async () => (await api.get("/codex-account")).data,
    staleTime: 15_000,
  });
  const legacy = !!selectedConfig && !["codex", "codex-cli", "claude-code", "deepseek-agent", "glm-agent"].includes(selectedConfig.engine);
  const ready = !!selectedConfig && !saving && !error &&
    (legacy ? !!selectedConfig.model : cliMode ? !!cliAccount.data?.connected : !!modelName);
  useEffect(() => { onReady?.(ready); }, [onReady, ready]);

  async function changeConfig(id: string) {
    if (!sessionId || saving || disabled) return;
    setSaving(true); setError("");
    try {
      await api.patch(`/sessions/${sessionId}`, { modelConfigId: id, modelName: null });
      setConfigId(id); setModelName("");
    } catch { setError("切换平台失败，请重试"); }
    finally { setSaving(false); }
  }
  async function changeModel(name: string) {
    if (!sessionId || !configId || saving || disabled) return;
    setSaving(true); setError("");
    try {
      await api.patch(`/sessions/${sessionId}`, { modelConfigId: configId, modelName: name || null });
      setModelName(name);
    } catch { setError("切换模型失败，请重试"); }
    finally { setSaving(false); }
  }

  if (!configs.length) return <span className="text-xs text-amber-600">请先到设置连接 AI 平台</span>;
  return <div className="flex min-w-0 flex-wrap items-center gap-2">
    <Select value={configId} onChange={(value) => void changeConfig(value)} disabled={disabled || saving} options={configs.map((item) => ({ value: item.id, label: item.label }))} size="sm" className="max-w-[150px]" buttonClassName="text-[11px]" title="AI 平台"/>
    <Select value={legacy ? selectedConfig?.model : modelName} onChange={(value) => void changeModel(value)} disabled={legacy || disabled || saving || models.isLoading || !!models.error} options={[
      { value: "", label: models.isLoading ? "读取模型…" : cliMode ? cliDefaultName ? `${cliDefaultName}（当前默认）` : "读取 Codex 默认模型…" : "选择模型" },
      ...(modelName && !models.data?.models.some((item) => item.id === modelName) ? [{ value: modelName, label: modelName }] : []),
      ...(models.data?.models || []).map((item) => ({ value: item.id, label: item.name })),
    ]} size="sm" className="max-w-[170px]" buttonClassName="text-[11px]" title="当前对话模型"/>
    {models.data?.source === "codex-cli" && <span className="text-[10px] text-slate-400">Codex CLI 模型</span>}
    {models.data?.source === "provider-api" && <span className="text-[10px] text-slate-400">API 可用模型</span>}
    {!legacy && <button type="button" disabled={disabled} className="text-[10px] text-slate-500 underline hover:text-slate-700 disabled:opacity-50" onClick={() => setManualOpen((value) => !value)}>手动填写模型 ID</button>}
    {manualOpen && !legacy && <div className="flex w-full gap-2"><input className="input h-8 min-w-0 flex-1 text-xs" disabled={disabled} value={manualModel} onChange={(event) => setManualModel(event.target.value)} placeholder="平台提供的模型 ID"/><button type="button" className="btn btn-secondary btn-sm" disabled={disabled || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(manualModel) || saving} onClick={() => { void changeModel(manualModel.trim()); setManualOpen(false); }}>使用</button></div>}
    {models.isError && <span className="text-[10px] text-red-500">模型列表读取失败</span>}
    {cliMode && !cliAccount.data?.connected && <span className="text-[10px] text-amber-600">请先到设置登录 Codex</span>}
    {error && <span className="text-[10px] text-red-500">{error}</span>}
  </div>;
}
