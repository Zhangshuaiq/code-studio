import { useEffect, useState, type ReactNode } from "react";
import { Cloud, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";

interface PrivacyState {
  settingsSync: boolean;
  conversationSync: boolean;
  sourceCodeSync: false;
  cloudSyncAvailable: boolean;
  audit: Array<{ key: string; enabled: boolean; changedAt: string }>;
}

export function DesktopPrivacySettings() {
  const [state, setState] = useState<PrivacyState>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { void load(); }, []);
  async function load() {
    const response = await fetch("/api/local/privacy");
    const body = await response.json();
    if (!response.ok) setError(body.message || `HTTP ${response.status}`); else setState(body);
  }
  async function update(key: "settingsSync" | "conversationSync", enabled: boolean) {
    if (!state) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/local/privacy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settingsSync: state.settingsSync, conversationSync: state.conversationSync, [key]: enabled }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      setState(body);
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setSaving(false); }
  }

  return <div className="h-full overflow-auto rounded-[22px] border border-white/80 bg-white/40 p-6 shadow-sm backdrop-blur-sm dark:border-slate-800/80 dark:bg-slate-950/25"><div className="mx-auto max-w-4xl"><div className="eyebrow">Privacy</div><h1 className="mt-1 text-2xl font-bold">隐私与同步</h1><p className="mt-1 text-sm text-muted">所有同步默认关闭，只有你明确开启的内容才具备同步资格。</p>
    <section className="card mt-6 divide-y divide-slate-200 overflow-hidden dark:divide-slate-800">
      <PrivacyRow icon={<Cloud size={18} />} title="同步应用设置" description="同步主题、编辑器偏好和非敏感界面设置。" checked={Boolean(state?.settingsSync)} disabled={!state?.cloudSyncAvailable || saving} onChange={(value) => void update("settingsSync", value)} />
      <PrivacyRow icon={<Cloud size={18} />} title="同步对话记录" description="同步智能助手对话；项目源码不会因此上传。" checked={Boolean(state?.conversationSync)} disabled={!state?.cloudSyncAvailable || saving} onChange={(value) => void update("conversationSync", value)} />
      <div className="flex items-center gap-4 p-5"><span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10"><LockKeyhole size={18} /></span><div className="min-w-0 flex-1"><div className="text-sm font-semibold">项目源码</div><div className="mt-1 text-xs text-muted">始终保留在当前设备，不属于设置或对话同步范围。</div></div><span className="rounded-full bg-emerald-50 px-3 py-1 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">仅本机</span></div>
    </section>
    {!state && !error && <div className="mt-6 flex items-center gap-2 text-xs text-muted"><LoaderCircle size={14} className="animate-spin" />正在读取设置…</div>}
    {state && !state.cloudSyncAvailable && <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-muted dark:border-slate-800 dark:bg-slate-900">当前版本未启用同步服务，所有数据继续只保存在本机。</div>}
    {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
    {!!state?.audit.length && <section className="card mt-6 p-5"><h2 className="flex items-center gap-2 text-sm font-bold"><ShieldCheck size={16} />最近变更</h2><div className="mt-3 space-y-2">{state.audit.map((item, index) => <div key={`${item.changedAt}-${index}`} className="flex items-center justify-between text-xs"><span>{item.key === "settingsSync" ? "应用设置同步" : "对话记录同步"} · {item.enabled ? "已开启" : "已关闭"}</span><span className="text-muted">{new Date(item.changedAt).toLocaleString()}</span></div>)}</div></section>}
  </div></div>;
}

function PrivacyRow({ icon, title, description, checked, disabled, onChange }: { icon: ReactNode; title: string; description: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex items-center gap-4 p-5"><span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">{icon}</span><div className="min-w-0 flex-1"><div className="text-sm font-semibold">{title}</div><div className="mt-1 text-xs text-muted">{description}</div></div><button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={`relative h-6 w-11 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${checked ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-700"}`}><span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`} /></button></div>;
}
