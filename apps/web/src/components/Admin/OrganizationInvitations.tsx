import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Select } from '../common/Select';
import { Card, errText } from '../Settings/ui';

interface Invitation { id: string; email: string; role: string; status: string; expiresAt: string }
export function OrganizationInvitations({ organizationId }: { organizationId: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState(''); const [role, setRole] = useState('member');
  const [token, setToken] = useState(''); const [error, setError] = useState('');
  const key = ['organization-invitations', organizationId];
  const invitations = useQuery<Invitation[]>({ queryKey: key, queryFn: async () => (await api.get(`/admin/organizations/${organizationId}/invitations`)).data });
  const create = useMutation({ mutationFn: async () => (await api.post(`/admin/organizations/${organizationId}/invitations`, { email, role })).data, onSuccess: (result) => { setToken(result.token); setEmail(''); void qc.invalidateQueries({ queryKey: key }); } });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/admin/organizations/${organizationId}/invitations/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
  async function invite(event: React.FormEvent) { event.preventDefault(); setError(''); setToken(''); try { await create.mutateAsync(); } catch (reason) { setError(errText(reason)); } }
  return <Card title="邀请员工"><form className="flex flex-wrap gap-2" onSubmit={(event) => void invite(event)}><input className="input min-w-48 flex-1" type="email" required aria-label="员工邮箱" placeholder="员工邮箱" value={email} onChange={(event) => setEmail(event.target.value)}/><Select className="w-32" value={role} onChange={setRole} options={[{ value: 'member', label: '成员' }, { value: 'admin', label: '管理员' }]}/><button className="btn btn-primary" disabled={create.isPending}>生成邀请</button></form>{token && <div className="mt-3 rounded-xl bg-indigo-50 p-3 dark:bg-indigo-500/10"><p className="text-xs">邀请代码仅展示一次，请发送给受邀员工，在账户页接受邀请。有效期 7 天。</p><input className="input mt-2 w-full font-mono" aria-label="生成的邀请代码" value={token} readOnly onFocus={(event) => event.target.select()}/></div>}{(error || invitations.error) && <p className="mt-3 text-xs text-red-500">{error || errText(invitations.error)}</p>}<div className="mt-4 space-y-2">{invitations.data?.map((item) => { const pending = item.status === 'pending' && new Date(item.expiresAt).getTime() > Date.now(); return <div key={item.id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-700"><span className="min-w-0 flex-1 truncate">{item.email} · {item.role === 'admin' ? '管理员' : '成员'}</span><span className="text-muted">{pending ? '待接受' : item.status === 'accepted' ? '已接受' : item.status === 'revoked' ? '已撤销' : '已过期'}</span>{pending && <button className="btn btn-ghost btn-sm" disabled={revoke.isPending} onClick={() => { setError(''); void revoke.mutateAsync(item.id).catch((reason) => setError(errText(reason))); }}>撤销</button>}</div>; })}</div></Card>;
}
