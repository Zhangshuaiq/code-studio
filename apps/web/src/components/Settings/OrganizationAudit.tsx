import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useOrganizationControl } from '../../lib/organization-control';
import { Select } from '../common/Select';
import { Card, errText } from './ui';

interface Entry { id: string; createdAt: string; actorName: string; action: string; result: string; statusCode?: number; detail?: unknown }
interface Page { items: Entry[]; total: number; page: number; pageSize: number }
const actions = [
  ['organization.create', '创建组织'], ['organization.member.add', '添加成员'], ['organization.member.remove', '移除成员'], ['organization.member.role.update', '修改角色'],
  ['organization.invitation.create', '生成邀请'], ['organization.invitation.accept', '接受邀请'], ['organization.invitation.revoke', '撤销邀请'],
  ['organization.domain.create', '创建域名验证'], ['organization.domain.verify', '验证域名'], ['organization.domain.remove', '移除域名'], ['organization.policy.update', '更新策略'],
];
export function OrganizationAudit({ organizationId }: { organizationId: string }) {
  const { api, identity: username } = useOrganizationControl();
  const [q, setQ] = useState(''); const [actor, setActor] = useState(''); const [action, setAction] = useState(''); const [result, setResult] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({}); const [page, setPage] = useState(1); const [error, setError] = useState('');
  const query = useQuery<Page>({ queryKey: ['organization-audit', username, organizationId, filters, page], queryFn: async () => (await api.get(`/control/enterprise/organizations/${organizationId}/audit`, { params: { ...filters, page, pageSize: 20 } })).data,
    retry: (failureCount, reason) => !(isAxiosError(reason) && [400, 401, 403].includes(reason.response?.status ?? 0)) && failureCount < 2,
  });
  // A permission failure must not leave an old cached audit table visible.
  const data = query.error ? undefined : query.data;
  function search(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if ([from, to].some((value) => value && !Number.isFinite(new Date(value).getTime()))) { setError('请输入有效的时间'); return; }
    if (from && to && from > to) { setError('开始时间不能晚于结束时间'); return; }
    setFilters({ ...(q.trim() ? { q: q.trim() } : {}), ...(actor.trim() ? { actor: actor.trim() } : {}), ...(action ? { action } : {}), ...(result ? { result } : {}), ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to).toISOString() } : {}) }); setPage(1);
  }
  return <div data-organization-audit><Card title="组织操作记录">
    <form className="flex flex-wrap gap-2" onSubmit={search}>
      <input className="input min-w-40 flex-1" aria-label="组织审计关键词" placeholder="关键词" maxLength={200} value={q} onChange={(event) => setQ(event.target.value)} />
      <input className="input min-w-32 flex-1" aria-label="组织审计操作者" placeholder="操作者" maxLength={200} value={actor} onChange={(event) => setActor(event.target.value)} />
      <Select className="w-40" value={action} options={[{ value: '', label: '全部操作' }, ...actions.map(([value, label]) => ({ value, label }))]} onChange={setAction} />
      <Select className="w-28" value={result} options={[{ value: '', label: '全部结果' }, { value: 'success', label: '成功' }, { value: 'failure', label: '失败' }]} onChange={setResult} />
      <input className="input" type="datetime-local" aria-label="组织审计开始时间" value={from} onChange={(event) => setFrom(event.target.value)} />
      <input className="input" type="datetime-local" aria-label="组织审计结束时间" value={to} onChange={(event) => setTo(event.target.value)} />
      <button className="btn btn-primary" disabled={query.isFetching}>查询</button><button className="btn btn-ghost" type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>刷新记录</button>
    </form>
    {(error || query.error) && <p role="alert" className="mt-3 text-xs text-red-500">{error || errText(query.error)}</p>}
    {query.isFetching && <p className="mt-3 text-xs text-muted">加载记录…</p>}
    {!query.isFetching && !query.error && !data?.items.length && <p className="mt-3 text-xs text-muted">没有匹配的记录。</p>}
    <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-slate-200 text-muted dark:border-slate-700"><th className="p-2">时间</th><th className="p-2">操作者</th><th className="p-2">操作</th><th className="p-2">结果</th><th className="p-2">详情</th></tr></thead><tbody>{data?.items.map((entry) => <tr key={entry.id} className="border-b border-slate-100 dark:border-slate-800"><td className="whitespace-nowrap p-2">{new Date(entry.createdAt).toLocaleString()}</td><td className="p-2">{entry.actorName}</td><td className="p-2">{actions.find(([value]) => value === entry.action)?.[1] || entry.action}</td><td className={`p-2 ${entry.result === 'success' ? 'text-emerald-600' : 'text-red-500'}`}>{entry.result === 'success' ? '成功' : '失败'}{entry.statusCode ? ` (${entry.statusCode})` : ''}</td><td className="p-2"><details><summary className="cursor-pointer">查看详情</summary><pre className="mt-2 max-w-lg overflow-auto whitespace-pre-wrap text-[10px]">{JSON.stringify(entry.detail, null, 2)}</pre></details></td></tr>)}</tbody></table></div>
    <div className="mt-3 flex items-center justify-end gap-3 text-xs"><span>共 {data?.total ?? 0} 条 · 第 {page} 页</span><button className="btn btn-ghost btn-sm" disabled={query.isFetching || page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><button className="btn btn-ghost btn-sm" disabled={query.isFetching || !data || page * 20 >= data.total} onClick={() => setPage((value) => value + 1)}>下一页</button></div>
  </Card></div>;
}
