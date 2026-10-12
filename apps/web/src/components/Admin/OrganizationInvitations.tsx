import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrganizationControl } from '../../lib/organization-control';
import { Select } from '../common/Select';
import { Card, errText } from '../Settings/ui';
import { useFeedback } from '../common/FeedbackProvider';
import { organizationRoleLabels } from '../../lib/organization-roles';

interface Invitation { id: string; email: string; role: string; status: string; expiresAt: string }
export function OrganizationInvitations({ organizationId, scope = 'platform', actorRole = 'owner' }: { organizationId: string; scope?: 'platform' | 'organization'; actorRole?: string }) {
  const qc = useQueryClient();
  const { api, identity: username } = useOrganizationControl(); const { confirm } = useFeedback();
  const [email, setEmail] = useState(''); const [role, setRole] = useState('member');
  const [token, setToken] = useState(''); const [error, setError] = useState('');
  const key = ['organization-invitations', scope, username, organizationId];
  const base = scope === 'platform' ? `/admin/organizations/${organizationId}/invitations` : `/control/enterprise/organizations/${organizationId}/invitations`;
  const canInviteAdmin = scope === 'platform' || actorRole === 'owner';
  const invitations = useQuery<Invitation[]>({ queryKey: key, queryFn: async () => (await api.get(base)).data });
  const create = useMutation({ mutationFn: async () => (await api.post(base, { email, role: canInviteAdmin ? role : 'member' })).data, onSuccess: (result) => { setToken(result.token); setEmail(''); void qc.invalidateQueries({ queryKey: key }); } });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`${base}/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
  async function invite(event: React.FormEvent) { event.preventDefault(); setError(''); setToken(''); try { await create.mutateAsync(); } catch (reason) { setError(errText(reason)); } }
  async function revokeWithConfirmation(id: string) { if (!await confirm({ title: '撤销邀请', message: '撤销后该邀请代码将无法使用，确定继续？', confirmText: '撤销邀请', tone: 'danger' })) return; setError(''); try { await revoke.mutateAsync(id); setToken(''); } catch (reason) { setError(errText(reason)); } }
  return <div data-organization-invitations><Card title="邀请员工">
    <form className="flex flex-wrap gap-2" onSubmit={(event) => void invite(event)}>
      <input className="input min-w-48 flex-1" type="email" required aria-label="员工邮箱" placeholder="员工邮箱" value={email} onChange={(event) => setEmail(event.target.value)} disabled={create.isPending}/>
      <Select className="w-32" value={canInviteAdmin ? role : 'member'} disabled={create.isPending} onChange={setRole} options={(canInviteAdmin ? ['member', 'admin', 'auditor'] : ['member']).map(value => ({ value, label: organizationRoleLabels[value] }))}/>
      <button className="btn btn-primary" disabled={create.isPending || revoke.isPending}>生成邀请</button>
    </form>
    {token && <div className="mt-3 rounded-xl bg-indigo-50 p-3 dark:bg-indigo-500/10"><p className="text-xs">邀请代码仅在本次生成后展示，请发送给受邀员工，在账户页接受邀请。有效期 7 天。</p><input className="input mt-2 w-full font-mono" aria-label="生成的邀请代码" value={token} readOnly onFocus={(event) => event.target.select()}/></div>}
    {(error || invitations.error) && <p role="alert" className="mt-3 text-xs text-red-500">{error || errText(invitations.error)}</p>}
    <div className="mt-4 space-y-2">{invitations.data?.map((item) => {
      const pending = item.status === 'pending' && new Date(item.expiresAt).getTime() > Date.now();
      return <div key={item.id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-700"><span className="min-w-0 flex-1 truncate">{item.email} · {organizationRoleLabels[item.role] || item.role}</span><span className="text-muted">{pending ? '待接受' : item.status === 'accepted' ? '已接受' : item.status === 'revoked' ? '已撤销' : '已过期'}</span>{pending && (canInviteAdmin || item.role === 'member') && <button className="btn btn-ghost btn-sm" disabled={revoke.isPending || create.isPending} onClick={() => void revokeWithConfirmation(item.id)}>撤销</button>}</div>;
    })}</div>
  </Card></div>;
}
