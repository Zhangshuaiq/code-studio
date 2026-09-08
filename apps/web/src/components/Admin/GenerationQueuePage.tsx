import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, RefreshCw, Workflow } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';

interface TaskRow {
  id: string; prompt: string; status: string; priority: number; resourceWaitCount: number;
  executorKind?: string | null; executionNamespace?: string | null; executionRef?: string | null;
  failureCode?: string | null; createdAt: string;
  session: { user: { username: string; displayName?: string | null }; project: { name: string; team?: { name: string } | null } };
}
interface TaskPage { items: TaskRow[]; total: number; pages: number }

export function GenerationQueuePage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const query = useQuery<TaskPage>({ queryKey: ['admin-generation-tasks', status], queryFn: async () => (await api.get('/agent/admin/tasks', { params: { status: status || undefined, pageSize: 100 } })).data, refetchInterval: 5000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-generation-tasks'] });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/agent/admin/tasks/${id}/cancel`), onSuccess: refresh });
  const priority = useMutation({ mutationFn: ({ id, value }: { id: string; value: number }) => api.post(`/agent/admin/tasks/${id}/priority`, { priority: value }), onSuccess: refresh });
  return <div>
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3"><div><div className="eyebrow">Generation Scheduler</div><h1 className="mt-1 text-2xl font-bold">生成资源队列</h1><p className="mt-1 text-sm text-muted">查看团队资源等待、调整优先级并强制终止异常任务</p></div><button className="btn btn-primary" onClick={() => query.refetch()}><RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} />刷新</button></header>
    <div className="mb-4 flex flex-wrap gap-2">{['', 'queued', 'running', 'cancelling', 'failed'].map((item) => <button key={item || 'all'} className={`btn btn-sm ${status === item ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setStatus(item)}>{item || '全部'}</button>)}</div>
    <div className="space-y-3">{query.data?.items.map((row) => <article key={row.id} className="card p-4"><div className="flex flex-wrap items-start gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10"><Workflow size={16} /></span><div className="min-w-0 flex-1"><div className="line-clamp-2 text-sm font-semibold">{row.prompt}</div><div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted"><span>{row.session.project.name}</span><span>{row.session.project.team?.name || '个人项目'}</span><span>{row.session.user.displayName || row.session.user.username}</span><span className="font-semibold">{row.status}</span><span>P{row.priority}</span>{row.resourceWaitCount > 0 && <span className="text-amber-600">资源等待 {row.resourceWaitCount} 次</span>}<span>{new Date(row.createdAt).toLocaleString('zh-CN')}</span></div>{row.executionRef && <div className="mt-2 truncate font-mono text-[10px] text-muted">{row.executionNamespace}/{row.executionRef}</div>}{row.failureCode && <div className="mt-1 text-xs text-red-500">失败分类：{row.failureCode}</div>}</div><div className="flex items-center gap-2">{row.status === 'queued' && <select className="input h-8 w-20 text-xs" value={row.priority} onChange={(event) => priority.mutate({ id: row.id, value: Number(event.target.value) })}>{Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>P{value}</option>)}</select>}{['queued', 'running', 'cancelling'].includes(row.status) && <button className="btn btn-ghost btn-sm text-red-500" disabled={cancel.isPending} onClick={() => cancel.mutate(row.id)}><Ban size={13} />终止</button>}</div></div></article>)}{!query.isLoading && !query.data?.items.length && <div className="card py-16 text-center text-sm text-muted">暂无生成任务</div>}</div>
  </div>;
}
