import type { EnterprisePolicy } from '../../hooks/useOrganizations';
import { useEffect, useRef, useState } from 'react';
import { Card } from '../Settings/ui';

export function PolicyCard({ value, onChange, saving, onSave, readOnly = false }: { value: EnterprisePolicy; onChange: (value: EnterprisePolicy) => void; saving: boolean; onSave: () => void; readOnly?: boolean }) {
  const fields = [
    ['allowedModelEngines', '允许的模型引擎（逗号分隔）'], ['allowedConnectorTypes', '允许的连接器'], ['allowedGitHosts', '允许的 Git 主机'], ['allowedNetworkHosts', '允许的网络主机'],
  ] as const;
  return <Card title="桌面安全策略"><fieldset disabled={saving || readOnly}>
    <label className="flex items-center gap-2 text-xs"><input aria-label="允许使用本地终端" type="checkbox" checked={value.terminalEnabled} onChange={(event) => onChange({ ...value, terminalEnabled: event.target.checked })} />允许使用本地终端</label>
    <div className="mt-4 grid gap-3 md:grid-cols-2">{fields.map(([key, label]) => <ListField key={key} label={label} value={value[key]} onChange={(items) => onChange({ ...value, [key]: items })} />)}
      <label className="block text-xs"><span className="mb-1 block text-muted">最低客户端版本</span><input aria-label="最低客户端版本" className="input w-full" value={value.minimumClientVersion} onChange={(event) => onChange({ ...value, minimumClientVersion: event.target.value })} /></label>
      <label className="block text-xs"><span className="mb-1 block text-muted">离线宽限天数</span><input aria-label="离线宽限天数" className="input w-full" type="number" min={0} max={90} value={value.offlineDays} onChange={(event) => onChange({ ...value, offlineDays: Number(event.target.value) })} /></label>
    </div></fieldset>{readOnly ? <p className="mt-4 text-xs text-muted">仅组织所有者可以修改安全策略。</p> : <button className="btn btn-primary mt-4" disabled={saving} onClick={onSave}>保存并用于下次策略签发</button>}</Card>;
}
function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  const joined = value.join(', '); const [text, setText] = useState(joined); const committed = useRef(joined);
  useEffect(() => { if (joined !== committed.current) setText(joined); committed.current = joined; }, [joined]);
  return <label className="block text-xs"><span className="mb-1 block text-muted">{label}</span><input aria-label={label} className="input w-full" value={text} onChange={(event) => { const raw = event.target.value; const items = raw.split(',').map((item) => item.trim()).filter(Boolean); setText(raw); committed.current = items.join(', '); onChange(items); }} /></label>;
}
