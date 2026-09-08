import { useEffect, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Clock3, LoaderCircle, RefreshCw, RotateCcw, Search, Square, TerminalSquare } from 'lucide-react';
import { useAgentTaskActions, useAgentTasks, AgentTaskItem } from '../../hooks/useAgentTasks';
import { Select } from '../common/Select';

const STATUS = [{ value: '', label: '全部状态' }, { value: 'queued', label: '排队中' }, { value: 'running', label: '执行中' }, { value: 'cancelling', label: '取消中' }, { value: 'succeeded', label: '已成功' }, { value: 'failed', label: '失败' }, { value: 'cancelled', label: '已取消' }, { value: 'timed_out', label: '已超时' }];

export function TaskCenterPage() {
  const [status, setStatus] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const query = useAgentTasks({ status: status || undefined, page, search: search || undefined });
  const actions = useAgentTaskActions();
  useEffect(() => setPage(1), [status, search]);
  return <div className="h-full overflow-y-auto rounded-[22px] border border-white/80 bg-white/45 dark:border-slate-800/80 dark:bg-slate-950/25"><div className="page-shell max-w-[1500px]"><header className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><div className="eyebrow">Generation Operations</div><h1 className="mt-1 text-2xl font-bold">生成任务中心</h1><p className="mt-1 text-sm text-muted">跨项目查看任务状态、失败日志并重新执行</p></div><button className="btn btn-primary" onClick={() => query.refetch()}><RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} />刷新</button></header><div className="card mb-4 flex flex-wrap items-center gap-3 p-4"><Select value={status} onChange={setStatus} options={STATUS} /><form className="flex min-w-[260px] flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); }}><div className="relative flex-1"><Search size={14} className="absolute left-3 top-3 text-slate-400" /><input className="input h-10 w-full pl-9" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="搜索任务需求" /></div><button className="btn btn-secondary" type="submit">搜索</button></form><div className="text-xs text-muted">共 {query.data?.total ?? 0} 条</div></div><div className="space-y-3">{query.data?.items.map((task) => <TaskCard key={task.id} task={task} retry={() => actions.retry.mutate(task.id)} cancel={() => actions.cancel.mutate(task.id)} busy={actions.retry.isPending || actions.cancel.isPending} />)}{!query.isLoading && !query.data?.items.length && <div className="card grid place-items-center py-20 text-sm text-muted"><TerminalSquare size={30} className="mb-3 opacity-40" />暂无匹配任务</div>}{query.isLoading && <div className="grid place-items-center py-20 text-muted"><LoaderCircle className="animate-spin" /></div>}</div><div className="mt-5 flex items-center justify-center gap-3"><button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((x) => x - 1)}><ChevronLeft size={14} />上一页</button><span className="text-xs text-muted">{page} / {Math.max(query.data?.pages ?? 1, 1)}</span><button className="btn btn-secondary" disabled={page >= (query.data?.pages ?? 1)} onClick={() => setPage((x) => x + 1)}>下一页<ChevronRight size={14} /></button></div></div></div>;
}

function TaskCard({ task, retry, cancel, busy }: { task: AgentTaskItem; retry: () => void; cancel: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const duration = task.finishedAt ? new Date(task.finishedAt).getTime() - new Date(task.startedAt || task.createdAt).getTime() : undefined;
  const retryable = ['failed', 'cancelled', 'timed_out'].includes(task.status);
  const cancellable = ['queued', 'running'].includes(task.status);
  return <article className="card overflow-hidden">
    <div className="flex flex-wrap items-start gap-4 p-4">
      <Status status={task.status} />
      <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((x) => !x)}>
        <div className="line-clamp-2 text-sm font-semibold">{task.prompt}</div>
        <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted">
          <span>{task.session.project.name}</span><span>{task.session.project.language}</span>
          {task.executorKind && <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold dark:bg-slate-800">{task.executorKind === 'kubernetes' ? 'Kubernetes Job' : 'Docker'}</span>}
          <span>优先级 P{task.priority}</span>
          {task.resourceWaitCount > 0 && <span>资源等待 {task.resourceWaitCount} 次</span>}
          <span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span>
          {duration !== undefined && <span className="flex items-center gap-1"><Clock3 size={10} />{formatDuration(duration)}</span>}
          {task.failureCode && <span className="font-semibold text-red-500">{failureLabel(task.failureCode)}</span>}
        </div>
      </button>
      <div className="flex items-center gap-2">{retryable && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={retry}><RotateCcw size={12} />重试</button>}{cancellable && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={cancel}><Square size={11} />取消</button>}<button className="icon-btn" onClick={() => setOpen((x) => !x)}><ChevronDown size={15} className={`transition ${open ? 'rotate-180' : ''}`} /></button></div>
    </div>
    {open && <div className="border-t border-slate-200 dark:border-slate-800">
      {(task.executionNamespace || task.executionRef) && <div className="flex flex-wrap gap-4 bg-slate-50 px-4 py-2 font-mono text-[10px] text-muted dark:bg-slate-900/60"><span>namespace: {task.executionNamespace || '-'}</span><span>job: {task.executionRef || '-'}</span></div>}
      <pre className="max-h-96 overflow-auto bg-slate-950 p-4 text-xs leading-5 text-slate-200">{task.resultLog || '任务尚无输出'}</pre>
    </div>}
  </article>;
}
function Status({ status }: { status: AgentTaskItem['status'] }) { const cfg = status === 'succeeded' ? ['成功', 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10'] : ['failed', 'timed_out'].includes(status) ? [status === 'timed_out' ? '超时' : '失败', 'bg-red-50 text-red-600 dark:bg-red-500/10'] : status === 'cancelled' ? ['已取消', 'bg-slate-100 text-slate-600 dark:bg-slate-800'] : ['running', 'cancelling'].includes(status) ? [status === 'cancelling' ? '取消中' : '执行中', 'bg-amber-50 text-amber-600 dark:bg-amber-500/10'] : ['排队中', 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10']; return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${cfg[1]}`}>{cfg[0]}</span>; }
function formatDuration(ms: number) { const seconds = Math.max(0, Math.round(ms / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }
function failureLabel(code: string) { return ({ command_failed: '构建命令失败', image_pull: '镜像拉取失败', oom_killed: '内存超限', evicted: 'Pod 被驱逐', deadline_exceeded: '执行超时', job_failed: 'Job 失败', cluster_error: '集群调用失败' } as Record<string, string>)[code] || code; }
