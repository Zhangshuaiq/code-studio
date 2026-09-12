import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';

interface CleanupItem {
  id: string;
  name: string;
  status: string;
  deletionAttempts: number;
  deletionStartedAt?: string | null;
  deletionNextAttemptAt?: string | null;
  deletionError?: string | null;
  deletionAcknowledgedAt?: string | null;
  deletionAcknowledgedByName?: string | null;
  deletionAcknowledgementNote?: string | null;
  deletionDeploymentSkipAt?: string | null;
  deletionDeploymentSkipByName?: string | null;
  deletionDeploymentSkipNote?: string | null;
  user: { username: string; displayName?: string | null };
  team?: { name: string } | null;
}

interface CleanupPage {
  items: CleanupItem[];
  page: number;
  total: number;
  pages: number;
  hasNext: boolean;
}

export function ProjectCleanupsPage() {
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [acknowledgeId, setAcknowledgeId] = useState('');
  const [acknowledgementNote, setAcknowledgementNote] = useState('');
  const query = useQuery<CleanupPage>({
    queryKey: ['project-cleanups', page],
    queryFn: async () => (await api.get('/admin/project-cleanups', { params: { page, pageSize: 50 } })).data,
    refetchInterval: 10_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/admin/project-cleanups/${id}/retry`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['project-cleanups'] }),
  });
  const forceRetry = useMutation({
    mutationFn: ({ id, projectName, note }: { id: string; projectName: string; note: string }) =>
      api.post(`/admin/project-cleanups/${id}/force-retry`, { projectName, note }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['project-cleanups'] }),
  });
  const confirmForceRetry = (item: CleanupItem) => {
    const projectName = window.prompt(`该操作不会再访问部署集群，并可能遗留远端资源。\n请输入项目名“${item.name}”确认：`);
    if (projectName == null) return;
    const note = window.prompt('请输入集群已移除的原因或处置依据（至少 10 个字符）：');
    if (note == null) return;
    forceRetry.mutate({ id: item.id, projectName, note });
  };
  const acknowledge = useMutation({
    mutationFn: () => api.patch(`/admin/project-cleanups/${acknowledgeId}/acknowledge`, { note: acknowledgementNote }),
    onSuccess: () => {
      setAcknowledgeId('');
      setAcknowledgementNote('');
      client.invalidateQueries({ queryKey: ['project-cleanups'] });
    },
  });
  return <div className="page-shell max-w-[1300px]">
    <header className="mb-6 flex items-end justify-between gap-4"><div><div className="eyebrow">Resource Reaper</div><h1 className="mt-1 text-2xl font-bold">项目资源回收</h1><p className="mt-1 text-sm text-muted">查看后台删除进度，并人工重试达到失败终态的项目</p></div><button className="btn btn-primary" onClick={() => query.refetch()}><RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} />刷新</button></header>
    {!!query.data?.items.some((item) => item.status === 'deletion_failed' && !item.deletionAcknowledgedAt) && <div className="card mb-4 grid gap-3 p-4 md:grid-cols-[260px_1fr_auto]"><select className="input" value={acknowledgeId} onChange={(event) => setAcknowledgeId(event.target.value)}><option value="">选择需要确认的失败项目</option>{query.data.items.filter((item) => item.status === 'deletion_failed' && !item.deletionAcknowledgedAt).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input className="input" maxLength={2000} value={acknowledgementNote} onChange={(event) => setAcknowledgementNote(event.target.value)} placeholder="填写排查结果或后续处置计划" /><button className="btn btn-secondary" disabled={!acknowledgeId || !acknowledgementNote.trim() || acknowledge.isPending} onClick={() => acknowledge.mutate()}>确认失败</button></div>}
    {!!query.data?.items.some((item) => item.deletionAcknowledgedAt) && <div className="mb-4 space-y-2">{query.data.items.filter((item) => item.deletionAcknowledgedAt).map((item) => <div key={item.id} className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200">{item.name}：{item.deletionAcknowledgedByName} 于 {new Date(item.deletionAcknowledgedAt!).toLocaleString('zh-CN')} 确认——{item.deletionAcknowledgementNote}</div>)}</div>}
    <div className="space-y-3">{query.data?.items.map((item) => <article key={item.id} className="card p-5"><div className="flex items-start gap-4"><span className={`grid h-10 w-10 place-items-center rounded-xl ${item.status === 'deletion_failed' ? 'bg-red-50 text-red-500 dark:bg-red-500/10' : 'bg-amber-50 text-amber-600 dark:bg-amber-500/10'}`}><AlertTriangle size={18} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-bold">{item.name}</h2><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold dark:bg-slate-800">{item.status}</span>{item.deletionDeploymentSkipAt && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-600">已授权跳过集群清理</span>}</div><div className="mt-1 flex flex-wrap gap-3 text-xs text-muted"><span>创建人：{item.user.displayName || item.user.username}</span><span>项目组：{item.team?.name || '个人项目'}</span><span>尝试：{item.deletionAttempts}</span>{item.deletionNextAttemptAt && <span>下次重试：{new Date(item.deletionNextAttemptAt).toLocaleString('zh-CN')}</span>}</div>{item.deletionDeploymentSkipAt && <p className="mt-2 text-xs text-red-600">{item.deletionDeploymentSkipByName} 授权：{item.deletionDeploymentSkipNote}</p>}{item.deletionError && <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-xl bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-200">{item.deletionError}</pre>}</div>{item.status === 'deletion_failed' && <div className="flex flex-col gap-2"><button className="btn btn-secondary btn-sm" disabled={retry.isPending || forceRetry.isPending} onClick={() => retry.mutate(item.id)}><RotateCcw size={13} />重新回收</button><button className="btn btn-danger btn-sm" disabled={retry.isPending || forceRetry.isPending} onClick={() => confirmForceRetry(item)}><Trash2 size={13} />集群已移除</button></div>}</div></article>)}{!query.isLoading && !query.data?.items.length && <div className="card py-16 text-center text-sm text-muted">没有待处理的项目资源</div>}</div>
    <div className="mt-5 flex justify-center gap-3"><button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={14} />上一页</button><span className="self-center text-xs text-muted">{page} / {Math.max(1, query.data?.pages || 1)}</span><button className="btn btn-secondary" disabled={!query.data?.hasNext} onClick={() => setPage((value) => value + 1)}>下一页<ChevronRight size={14} /></button></div>
  </div>;
}
