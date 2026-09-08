import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Hammer, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';

interface BuildRow { id: string; projectId: string; userId: string; jobName: string; image: string; status: string; queuedAt: string; startedAt?: string | null; durationMs?: number | null; logsTail?: string | null }
interface BuildQueue { items: BuildRow[]; total: number; page: number; pageSize: number; pages: number; hasNext: boolean; statuses: Record<string, number> }

export function PreviewBuildQueuePage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery<BuildQueue>({ queryKey: ['admin-preview-builds', status, page], queryFn: async () => (await api.get('/admin/preview-builds', { params: { status: status || undefined, page, pageSize: 50 } })).data, refetchInterval: 5000 });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/admin/preview-builds/${id}/cancel`), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-preview-builds'] }) });
  return <div>
    <header className="mb-6 flex items-end justify-between"><div><div className="eyebrow">Preview Build Queue</div><h1 className="mt-1 text-2xl font-bold">预览构建队列</h1><p className="mt-1 text-sm text-muted">查看 BuildKit 排队、执行和失败状态，必要时强制取消任务</p></div><button className="btn btn-primary" onClick={() => query.refetch()}><RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} />刷新</button></header>
    <div className="mb-4 flex flex-wrap gap-2">{['', 'queued', 'building', 'failed', 'succeeded', 'cancelled'].map((item) => <button key={item || 'all'} onClick={() => { setStatus(item); setPage(1); }} className={`btn btn-sm ${status === item ? 'btn-primary' : 'btn-secondary'}`}>{item || '全部'} {item ? query.data?.statuses[item] ?? 0 : query.data?.total ?? 0}</button>)}</div>
    <div className="space-y-3">{query.data?.items.map((row) => <article key={row.id} className="card p-4"><div className="flex items-start gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10"><Hammer size={16} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><b className="text-sm">{row.jobName}</b><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] dark:bg-slate-800">{row.status}</span></div><div className="mt-1 truncate font-mono text-[10px] text-muted">{row.image}</div><div className="mt-1 flex flex-wrap gap-3 text-[10px] text-muted"><span>项目 {row.projectId}</span><span>用户 {row.userId}</span><span>{new Date(row.queuedAt).toLocaleString('zh-CN')}</span>{row.durationMs != null && <span>{(row.durationMs / 1000).toFixed(1)} 秒</span>}</div>{row.logsTail && <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-950 p-3 text-xs text-red-200">{row.logsTail}</pre>}</div>{['queued', 'building'].includes(row.status) && <button className="btn btn-ghost btn-sm text-red-500" disabled={cancel.isPending} onClick={() => cancel.mutate(row.id)}><Ban size={13} />取消</button>}</div></article>)}{!query.isLoading && !query.data?.items.length && <div className="card py-16 text-center text-sm text-muted">暂无构建任务</div>}</div>
    {(query.data?.pages ?? 0) > 1 && <footer className="mt-4 flex items-center justify-end gap-3 text-xs text-muted"><span>第 {query.data?.page} / {query.data?.pages} 页，共 {query.data?.total} 条</span><button className="btn btn-secondary btn-sm" disabled={page <= 1 || query.isFetching} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button><button className="btn btn-secondary btn-sm" disabled={!query.data?.hasNext || query.isFetching} onClick={() => setPage((value) => value + 1)}>下一页</button></footer>}
  </div>;
}
