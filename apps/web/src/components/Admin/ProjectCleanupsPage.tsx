import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, RotateCcw } from 'lucide-react';
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

interface ImportItem {
  id: string;
  name: string;
  status: string;
  importAttempts: number;
  importStartedAt?: string | null;
  importFinishedAt?: string | null;
  importLeaseUntil?: string | null;
  importError?: string | null;
  remote?: { remoteUrl: string; branch: string } | null;
  user: { username: string; displayName?: string | null };
  team?: { name: string } | null;
}

interface ImportPage extends Omit<CleanupPage, 'items'> {
  items: ImportItem[];
}

export function ProjectCleanupsPage() {
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [acknowledgeId, setAcknowledgeId] = useState('');
  const [acknowledgementNote, setAcknowledgementNote] = useState('');
  const [importPage, setImportPage] = useState(1);
  const query = useQuery<CleanupPage>({
    queryKey: ['project-cleanups', page],
    queryFn: async () => (await api.get('/admin/project-cleanups', { params: { page, pageSize: 50 } })).data,
    refetchInterval: 10_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/admin/project-cleanups/${id}/retry`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['project-cleanups'] }),
  });
  const acknowledge = useMutation({
    mutationFn: () => api.patch(`/admin/project-cleanups/${acknowledgeId}/acknowledge`, { note: acknowledgementNote }),
    onSuccess: () => {
      setAcknowledgeId('');
      setAcknowledgementNote('');
      client.invalidateQueries({ queryKey: ['project-cleanups'] });
    },
  });
  const imports = useQuery<ImportPage>({
    queryKey: ['project-imports', importPage],
    queryFn: async () => (await api.get('/admin/project-imports', { params: { page: importPage, pageSize: 50 } })).data,
    refetchInterval: 10_000,
  });
  const retryImport = useMutation({
    mutationFn: (id: string) => api.post(`/admin/project-imports/${id}/retry`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['project-imports'] });
      client.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  return <div className="page-shell max-w-[1300px]">
    <header className="mb-6 flex items-end justify-between gap-4"><div><div className="eyebrow">Project Operations</div><h1 className="mt-1 text-2xl font-bold">项目后台任务</h1><p className="mt-1 text-sm text-muted">诊断 Git 导入与资源回收任务，并安全地重新排队失败任务</p></div><button className="btn btn-primary" onClick={() => { void query.refetch(); void imports.refetch(); }}><RefreshCw size={14} className={query.isFetching || imports.isFetching ? 'animate-spin' : ''} />刷新</button></header>
    <section className="mb-8">
      <div className="mb-3"><div className="eyebrow">Git imports</div><h2 className="mt-1 text-lg font-bold">Git 导入任务</h2></div>
      <div className="space-y-3">{imports.data?.items.map((item) => <article key={item.id} className="card p-5"><div className="flex items-start gap-4"><span className={`grid h-10 w-10 place-items-center rounded-xl ${item.status === 'import_failed' ? 'bg-red-50 text-red-500 dark:bg-red-500/10' : 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10'}`}><RefreshCw size={18} className={item.status === 'importing' ? 'animate-spin' : ''}/></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold">{item.name}</h3><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold dark:bg-slate-800">{item.status}</span></div><div className="mt-1 flex flex-wrap gap-3 text-xs text-muted"><span>创建人：{item.user.displayName || item.user.username}</span><span>项目组：{item.team?.name || '个人项目'}</span><span>尝试：{item.importAttempts}</span>{item.importLeaseUntil && <span>租约截止：{new Date(item.importLeaseUntil).toLocaleString('zh-CN')}</span>}</div>{item.remote && <div className="mt-2 truncate font-mono text-[11px] text-muted" title={item.remote.remoteUrl}>{item.remote.remoteUrl} · {item.remote.branch || '自动识别分支'}</div>}{item.importError && <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-xl bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-200">{item.importError}</pre>}</div>{item.status === 'import_failed' && <button className="btn btn-secondary btn-sm" disabled={retryImport.isPending} onClick={() => retryImport.mutate(item.id)}><RotateCcw size={13}/>重新导入</button>}</div></article>)}{!imports.isLoading && !imports.data?.items.length && <div className="card py-12 text-center text-sm text-muted">没有待处理的 Git 导入任务</div>}</div>
      <Pager page={importPage} pages={imports.data?.pages} hasNext={imports.data?.hasNext} onPage={setImportPage}/>
    </section>
    <div className="mb-3"><div className="eyebrow">Resource reaper</div><h2 className="mt-1 text-lg font-bold">资源回收任务</h2></div>
    {!!query.data?.items.some((item) => item.status === 'deletion_failed' && !item.deletionAcknowledgedAt) && <div className="card mb-4 grid gap-3 p-4 md:grid-cols-[260px_1fr_auto]"><select className="input" value={acknowledgeId} onChange={(event) => setAcknowledgeId(event.target.value)}><option value="">选择需要确认的失败项目</option>{query.data.items.filter((item) => item.status === 'deletion_failed' && !item.deletionAcknowledgedAt).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input className="input" maxLength={2000} value={acknowledgementNote} onChange={(event) => setAcknowledgementNote(event.target.value)} placeholder="填写排查结果或后续处置计划" /><button className="btn btn-secondary" disabled={!acknowledgeId || !acknowledgementNote.trim() || acknowledge.isPending} onClick={() => acknowledge.mutate()}>确认失败</button></div>}
    {!!query.data?.items.some((item) => item.deletionAcknowledgedAt) && <div className="mb-4 space-y-2">{query.data.items.filter((item) => item.deletionAcknowledgedAt).map((item) => <div key={item.id} className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200">{item.name}：{item.deletionAcknowledgedByName} 于 {new Date(item.deletionAcknowledgedAt!).toLocaleString('zh-CN')} 确认——{item.deletionAcknowledgementNote}</div>)}</div>}
    <div className="space-y-3">{query.data?.items.map((item) => <article key={item.id} className="card p-5"><div className="flex items-start gap-4"><span className={`grid h-10 w-10 place-items-center rounded-xl ${item.status === 'deletion_failed' ? 'bg-red-50 text-red-500 dark:bg-red-500/10' : 'bg-amber-50 text-amber-600 dark:bg-amber-500/10'}`}><AlertTriangle size={18} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-bold">{item.name}</h2><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold dark:bg-slate-800">{item.status}</span></div><div className="mt-1 flex flex-wrap gap-3 text-xs text-muted"><span>创建人：{item.user.displayName || item.user.username}</span><span>项目组：{item.team?.name || '个人项目'}</span><span>尝试：{item.deletionAttempts}</span>{item.deletionNextAttemptAt && <span>下次重试：{new Date(item.deletionNextAttemptAt).toLocaleString('zh-CN')}</span>}</div>{item.deletionError && <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-xl bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-200">{item.deletionError}</pre>}</div>{item.status === 'deletion_failed' && <button className="btn btn-secondary btn-sm" disabled={retry.isPending} onClick={() => retry.mutate(item.id)}><RotateCcw size={13} />重新回收</button>}</div></article>)}{!query.isLoading && !query.data?.items.length && <div className="card py-16 text-center text-sm text-muted">没有待处理的项目资源</div>}</div>
    <Pager page={page} pages={query.data?.pages} hasNext={query.data?.hasNext} onPage={setPage}/>
  </div>;
}

function Pager({ page, pages, hasNext, onPage }: { page: number; pages?: number; hasNext?: boolean; onPage: (page: number) => void }) {
  return <div className="mt-5 flex justify-center gap-3"><button className="btn btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={14}/>上一页</button><span className="self-center text-xs text-muted">{page} / {Math.max(1, pages || 1)}</span><button className="btn btn-secondary" disabled={!hasNext} onClick={() => onPage(page + 1)}>下一页<ChevronRight size={14}/></button></div>;
}
