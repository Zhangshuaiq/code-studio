import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useModelConfigs, useModelConfigMutations } from "../../hooks/useModelConfigs";
import { PageHeader, EmptyState, Card, Field, errText } from "./ui";
import { Select } from "../common/Select";

const PLATFORMS = [
  { engine: "codex-cli", name: "OpenAI · Codex CLI", note: "使用当前平台用户自己的 ChatGPT/Codex 登录态；在部署机器的独立 Agent Worker 上运行" },
  { engine: "codex", name: "OpenAI · Codex API Key", note: "使用个人 OpenAI Platform API Key，按 API 用量计费" },
  { engine: "claude-code", name: "Anthropic · Claude", note: "使用个人 Anthropic Console API Key，按 API 用量计费" },
  { engine: "deepseek-agent", name: "DeepSeek", note: "使用个人 DeepSeek API Key" },
  { engine: "glm-agent", name: "智谱 GLM", note: "使用个人智谱开放平台 API Key" },
] as const;

export function ModelsPage() {
  const queryClient = useQueryClient();
  const { data: configs = [] } = useModelConfigs();
  const { create, setDefault, remove, updateKey } = useModelConfigMutations();
  const [showForm, setShowForm] = useState(false);
  const [engine, setEngine] = useState<string>(PLATFORMS[0].engine);
  const [label, setLabel] = useState<string>(PLATFORMS[0].name);
  const [apiKey, setApiKey] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replacementKey, setReplacementKey] = useState("");
  const [deviceLogin, setDeviceLogin] = useState<{ verificationUrl: string; userCode: string } | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState("");
  const platform = PLATFORMS.find((item) => item.engine === engine)!;
  const hasCliConfig = configs.some((item) => item.engine === "codex-cli");
  const account = useQuery<{ connected: boolean }>({
    queryKey: ["codex-account"],
    enabled: (showForm && engine === "codex-cli") || hasCliConfig,
    queryFn: async () => (await api.get("/codex-account")).data,
    refetchInterval: deviceLogin ? 3000 : false,
  });
  const hostLogin = useQuery<{ detected: boolean; bindable: boolean }>({
    queryKey: ["codex-host-login"],
    enabled: showForm && engine === "codex-cli" && account.data?.connected === false,
    queryFn: async () => (await api.get("/codex-account/host-login")).data,
  });
  useEffect(() => { if (account.data?.connected) setDeviceLogin(null); }, [account.data?.connected]);
  const cliMode = engine === "codex-cli";

  async function save() {
    if (!label.trim() || (!cliMode && !apiKey.trim()) || (cliMode && !account.data?.connected)) return;
    await create.mutateAsync({ label: label.trim(), engine, ...(cliMode ? {} : { apiKey: apiKey.trim() }) });
    setApiKey("");
    setShowForm(false);
  }

  return <div>
    <PageHeader title="AI 平台连接" desc="Codex 可选个人 CLI 登录或个人 API Key；具体模型在项目对话框中选择。两种方式的额度分别计算。" action={
      <button className="btn btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => setShowForm((value) => !value)}>{showForm ? "取消" : <><Plus size={15}/>连接平台</>}</button>
    }/>
    {showForm && <div className="mb-6"><Card title="连接 AI 平台"><div className="space-y-3">
      <div><label className="label mb-1">平台</label><Select value={engine} onChange={(value) => { setEngine(value); setLabel(PLATFORMS.find((item) => item.engine === value)?.name || value); setApiKey(""); setDeviceLogin(null); }} options={PLATFORMS.map((item) => ({ value: item.engine, label: item.name }))}/></div>
      <p className="text-xs text-muted">{platform.note}。Worker 通过智能体按需读取、编辑项目代码。</p>
      {cliMode && <div className="rounded-lg border border-border p-3 text-xs">
        <p>Codex 个人账号：{account.data?.connected ? "已连接" : account.isLoading ? "检测中…" : "未连接"}</p>
        {!account.data?.connected && hostLogin.data?.bindable && <div className="mt-2 rounded-md bg-indigo-50 p-2 dark:bg-indigo-500/10">
          <p>检测到平台服务器已登录 Codex CLI，可绑定到当前平台用户。此操作不会共享给其他用户。</p>
          <button className="btn btn-secondary btn-sm mt-2" disabled={accountBusy} onClick={async () => {
            if (!window.confirm("将平台服务器上的 Codex 登录凭证复制到当前平台用户的专用目录。此登录态只能绑定给一位平台用户，确定继续吗？")) return;
            setAccountBusy(true); setAccountError("");
            try { await api.post("/codex-account/bind-host"); await queryClient.invalidateQueries({ queryKey: ["codex-account"] }); }
            catch (error) { setAccountError(errText(error)); }
            finally { setAccountBusy(false); }
          }}>绑定服务器已有登录</button>
        </div>}
        {!account.data?.connected && hostLogin.data && !hostLogin.data.bindable && <p className="mt-2 text-muted">平台服务器未检测到可绑定的文件型 Codex 登录态；可以使用个人账号完成登录。浏览器所在电脑的登录态不会自动传到服务器。</p>}
        {!account.data?.connected ? <button className="btn btn-secondary btn-sm mt-2" disabled={accountBusy} onClick={async () => {
          setAccountBusy(true); setAccountError("");
          try { setDeviceLogin((await api.post("/codex-account/device-login")).data); }
          catch (error) { setAccountError(errText(error)); }
          finally { setAccountBusy(false); }
        }}>{accountBusy ? "正在获取设备码…" : "使用个人账号登录"}</button> : <button className="btn btn-ghost btn-sm mt-2" disabled={accountBusy} onClick={async () => {
          if (!window.confirm("确定退出此平台用户的 Codex 登录吗？")) return;
          setAccountBusy(true); setAccountError("");
          try { await api.delete("/codex-account"); setDeviceLogin(null); await queryClient.invalidateQueries({ queryKey: ["codex-account"] }); }
          catch (error) { setAccountError(errText(error)); }
          finally { setAccountBusy(false); }
        }}>退出登录</button>}
        {deviceLogin && !account.data?.connected && <p className="mt-2">打开 <a className="text-indigo-600 underline" href={deviceLogin.verificationUrl} target="_blank" rel="noreferrer">验证页面</a>，输入设备码 <strong>{deviceLogin.userCode}</strong>，完成后本页会自动更新。</p>}
        {accountError && <p className="mt-2 text-red-500">{accountError}</p>}
        {account.isError && <p className="mt-2 text-red-500">无法检查 Codex 登录状态：{errText(account.error)}</p>}
      </div>}
      <Field label="连接名称" value={label} onChange={setLabel} placeholder="如 我的工作账号"/>
      {!cliMode && <Field label="API Key" value={apiKey} onChange={setApiKey} placeholder="仅加密存储，不会回显" type="password"/>}
      <button className="btn btn-primary w-full" disabled={create.isPending || !label.trim() || (cliMode ? !account.data?.connected : !apiKey.trim())} onClick={() => void save()}>{create.isPending ? "保存中…" : "保存连接"}</button>
      {create.isError && <p className="text-xs text-red-500">保存失败：{errText(create.error)}</p>}
    </div></Card></div>}
    <div className="space-y-2">
      {!configs.length && <EmptyState>尚未连接 AI 平台。可选择个人 Codex CLI 登录或添加个人 API 凭证。</EmptyState>}
      {configs.map((item) => <div key={item.id} className="card flex flex-wrap items-center gap-3 px-4 py-3.5">
        <input type="radio" name="default" checked={item.isDefault} onChange={() => setDefault.mutate(item.id)} title="设为默认平台" className="accent-indigo-600"/>
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{item.label}</span>{item.isDefault && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">默认</span>}</div><p className="truncate text-xs text-muted">{PLATFORMS.find((p) => p.engine === item.engine)?.name || item.provider} · {item.keyMasked}{item.model && !PLATFORMS.some((p) => p.engine === item.engine) ? ` · 旧配置模型 ${item.model}` : ""}</p></div>
        {item.engine !== "codex-cli" && <button className="btn btn-ghost btn-sm" onClick={() => { setEditingId(editingId === item.id ? null : item.id); setReplacementKey(""); }}>更新 Key</button>}
        {item.engine === "codex-cli" && <span className="text-xs text-muted">{account.data?.connected ? "已登录" : "请重新登录"}</span>}
        <button className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10" title="删除" onClick={() => { if (window.confirm(`确定删除 ${item.label}？`)) remove.mutate(item.id); }}><Trash2 size={15}/></button>
        {editingId === item.id && <div className="flex w-full gap-2"><input className="input flex-1" type="password" autoComplete="off" value={replacementKey} onChange={(event) => setReplacementKey(event.target.value)} placeholder="输入新的个人 API Key"/><button className="btn btn-primary btn-sm" disabled={!replacementKey.trim() || updateKey.isPending} onClick={async () => { await updateKey.mutateAsync({ id: item.id, apiKey: replacementKey.trim() }); setReplacementKey(""); setEditingId(null); }}>保存</button></div>}
      </div>)}
    </div>
  </div>;
}
