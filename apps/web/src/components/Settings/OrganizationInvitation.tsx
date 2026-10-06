import { useState } from 'react';
import { api } from '../../lib/api';
import { Card, errText } from './ui';

export function OrganizationInvitation({ desktop = false }: { desktop?: boolean }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function accept() {
    setBusy(true); setMessage('');
    try {
      const endpoint = desktop ? '/api/local/account/enterprise/invitations/accept' : '/control/enterprise/invitations/accept';
      const result = desktop
        ? await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token.trim() }) }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.message); return body; })
        : (await api.post(endpoint, { token: token.trim() })).data;
      setToken(''); setMessage(`已加入 ${result.organization.name}`);
    } catch (error) { setMessage(errText(error)); }
    finally { setBusy(false); }
  }
  return <Card title="加入企业组织"><p className="mb-3 text-xs text-muted">使用收到邀请的邮箱账户登录，输入管理员提供的邀请代码。</p><div className="flex gap-2"><input className="input min-w-0 flex-1" aria-label="企业邀请代码" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="邀请代码"/><button className="btn btn-primary" disabled={busy || token.trim().length < 40} onClick={() => void accept()}>{busy ? '加入中…' : '接受邀请'}</button></div>{message && <p className="mt-3 text-xs" role="status">{message}</p>}</Card>;
}
