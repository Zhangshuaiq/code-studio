import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Card, errText } from '../Settings/ui';
import { useFeedback } from '../common/FeedbackProvider';

interface Domain { id: string; domain: string; expiresAt: string; verifiedAt: string | null; recordName: string; recordValue: string }
export function OrganizationDomains({ organizationId }: { organizationId: string }) {
  const qc = useQueryClient(); const { confirm } = useFeedback();
  const [domain, setDomain] = useState(''); const [error, setError] = useState('');
  const key = ['organization-domains', organizationId];
  const base = `/admin/organizations/${organizationId}/domains`;
  const domains = useQuery<Domain[]>({ queryKey: key, queryFn: async () => (await api.get(base)).data });
  const action = useMutation({ mutationFn: async ({ operation, id }: { operation: 'create' | 'verify' | 'remove'; id?: string }) => {
    if (operation === 'create') return api.post(base, { domain });
    if (operation === 'verify') return api.post(`${base}/${id}/verify`);
    return api.delete(`${base}/${id}`);
  }, onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['organizations'] }); } });
  async function perform(operation: 'create' | 'verify' | 'remove', id?: string) {
    if (operation === 'remove' && !await confirm({ title: '移除企业域名', message: '移除后该域名将不再属于此组织的已验证域名。', tone: 'danger' })) return;
    setError(''); try { await action.mutateAsync({ operation, id }); if (operation === 'create') setDomain(''); } catch (reason) { setError(errText(reason)); }
  }
  return <Card title="企业域名"><p className="mb-3 text-xs text-muted">通过 DNS TXT 记录确认域名所有权。验证域名不会自动为该域名的账户授予组织权限。</p><form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void perform('create'); }}><input className="input min-w-0 flex-1" aria-label="企业域名" placeholder="company.com" value={domain} onChange={(event) => setDomain(event.target.value)} required/><button className="btn btn-primary" disabled={action.isPending}>生成验证记录</button></form>{(error || domains.error) && <p className="mt-3 text-xs text-red-500" role="alert">{error || errText(domains.error)}</p>}<div className="mt-4 space-y-3">{domains.data?.map((item) => <div key={item.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div className="flex items-center gap-3 text-xs"><b className="min-w-0 flex-1 truncate">{item.domain}</b><span className="text-muted">{item.verifiedAt ? '已验证' : new Date(item.expiresAt).getTime() <= Date.now() ? '已过期' : '待验证'}</span>{!item.verifiedAt && <button className="btn btn-primary btn-sm" disabled={action.isPending} onClick={() => void perform('verify', item.id)}>检查 DNS</button>}<button className="btn btn-ghost btn-sm" disabled={action.isPending} onClick={() => void perform('remove', item.id)}>移除</button></div>{!item.verifiedAt && <div className="mt-3 space-y-2 text-xs"><label className="block">TXT 记录名称<input className="input mt-1 w-full font-mono" value={item.recordName} readOnly onFocus={(event) => event.target.select()}/></label><label className="block">TXT 记录值<input className="input mt-1 w-full font-mono" value={item.recordValue} readOnly onFocus={(event) => event.target.select()}/></label><p className="text-muted">有效至 {new Date(item.expiresAt).toLocaleString()}；过期后重新生成记录。</p></div>}</div>)}</div></Card>;
}
