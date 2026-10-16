import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Select } from '../common/Select';
import { CodeDiffView } from '../CodeEditor/CodeDiffView';
type Change = { path: string; oldPath?: string; kind: string };
export type GitRead = (params: Record<string, string>, signal?: AbortSignal) => Promise<any>;
export function GitCompareModal({ scope, branches, current, load, onClose }: { scope: string; branches: string[]; current: string; load: GitRead; onClose: () => void }) {
  const [left, setLeft] = useState(current || 'HEAD'), [right, setRight] = useState(branches.find(branch => branch !== current) || current || 'HEAD');
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<Change>();
  const branchKey = branches.join('\0');
  useEffect(() => { setRight(value => value === current || value === 'HEAD' ? branches.find(branch => branch !== current) || value : value); }, [branchKey, current]);
  const list = useQuery({ queryKey: ['git-compare', scope, left, right, offset], queryFn: ({ signal }) => load({ left, right, offset: String(offset) }, signal) });
  useEffect(() => { setOffset(0); setSelected(undefined); }, [left, right]);
  useEffect(() => { setSelected(list.data?.items?.[0]); }, [list.data]);
  const file = useQuery({ queryKey: ['git-compare-file', scope, list.data?.left, list.data?.right, selected?.path, selected?.oldPath], enabled: !!selected && !!list.data, queryFn: ({ signal }) => load({ left: list.data.left, right: list.data.right, path: selected!.path, ...(selected?.oldPath ? { oldPath: selected.oldPath } : {}) }, signal) });
  const choices = [...new Set(['HEAD', current, ...branches].filter(Boolean))].map(value => ({ value, label: value }));
  return <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/50 p-6"><section role="dialog" aria-label="分支对比" className="flex h-[85vh] w-full max-w-[1600px] min-w-0 flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-slate-900">
    <header className="flex items-center gap-3 border-b p-3"><h2 className="text-sm font-semibold">分支对比</h2><Select searchable ariaLabel="左侧分支" searchPlaceholder="搜索左侧分支" value={left} options={choices} onChange={setLeft} className="min-w-0 flex-1"/><button className="btn btn-sm" title="交换左右分支" onClick={() => { setLeft(right); setRight(left); }}>⇄</button><Select searchable ariaLabel="右侧分支" searchPlaceholder="搜索右侧分支" value={right} options={choices} onChange={setRight} className="min-w-0 flex-1"/><button className="icon-btn" aria-label="关闭分支对比" onClick={onClose}><X size={16}/></button></header>
    <div className="flex min-h-0 flex-1"><aside className="flex w-64 shrink-0 flex-col border-r"><div className="p-3 text-xs text-muted">{list.data?.total || 0} 个变更文件 · 只读比较，不切换分支</div><div className="min-h-0 flex-1 overflow-auto">{list.error && <p role="alert" className="p-3 text-xs text-red-500">{list.error.message}</p>}{list.data?.items.map((item: Change) => <button key={item.path} title={item.path} className={`block w-full truncate px-3 py-2 text-left text-xs ${selected?.path === item.path ? 'bg-indigo-500/10 text-indigo-500' : ''}`} onClick={() => setSelected(item)}>{item.kind === 'added' ? '+' : item.kind === 'deleted' ? '−' : '↔'} {item.path}</button>)}</div><div className="flex gap-2 p-2"><button className="btn btn-sm" disabled={!offset || list.isFetching} onClick={() => setOffset(Math.max(0, offset - 200))}>上一页</button><button className="btn btn-sm" disabled={!list.data?.hasMore || list.isFetching} onClick={() => setOffset(offset + 200)}>下一页</button></div></aside>
    <div className="min-w-0 flex-1">{file.isLoading ? <p className="p-4 text-xs">正在读取文件差异…</p> : file.error ? <p role="alert" className="p-4 text-xs text-red-500">{file.error.message}</p> : file.data?.fileType ? <p className="p-4 text-xs">{file.data.fileType === 'binary' ? '二进制文件不支持文本对比' : '文件超过文本对比上限'}</p> : file.data && selected ? <CodeDiffView key={`${file.data.left}:${file.data.right}:${selected.path}`} path={selected.path} before={file.data.before} after={file.data.after} leftLabel={left} rightLabel={right}/> : <p className="p-4 text-xs text-muted">选择变更文件查看两栏对比</p>}</div></div>
  </section></div>;
}

export function WorkingDiffModal({ scope, path, load, onApply, onClose }: { scope: string; path: string; load: GitRead; onApply: (content: string, baseline: string) => Promise<void>; onClose: () => void }) {
  const [stage, setStage] = useState('working'), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const query = useQuery({ queryKey: ['git-working-diff', scope, path, stage], queryFn: ({ signal }) => load({ path, stage }, signal), refetchOnWindowFocus: false });
  useEffect(() => { if (query.data) setDraft(query.data.after); }, [query.data]);
  const close = () => { if (!query.data || draft === query.data.after || window.confirm('放弃当前差异草稿并关闭？')) onClose(); };
  const switchStage = (value: string) => { if (!query.data || draft === query.data.after || window.confirm('放弃当前差异草稿并切换对比范围？')) setStage(value); };
  return <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/50 p-6"><section role="dialog" aria-label="工作区变更对比" className="flex h-[85vh] w-full max-w-[1600px] min-w-0 flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-slate-900">
    <header className="flex items-center gap-3 border-b p-3 text-xs"><span className="min-w-0 flex-1 truncate" title={path}>{path}</span><Select ariaLabel="变更对比范围" value={stage} onChange={switchStage} options={[{ value:'working', label:'暂存区 ↔ 工作区' },{value:'staged',label:'HEAD ↔ 暂存区（只读）'}]}/><button className="btn btn-primary btn-sm" disabled={busy || !query.data || stage !== 'working' || !!query.data.fileType || !query.data.exists || draft === query.data.after} onClick={async () => { setBusy(true); setError(''); try { await onApply(draft, query.data.after); onClose(); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); } }}>应用到编辑器草稿</button><button className="icon-btn" aria-label="关闭变更对比" onClick={close}><X size={16}/></button></header>
    {error && <p role="alert" className="p-2 text-xs text-red-500">{error}</p>}
    <div className="min-h-0 flex-1">{query.error ? <p role="alert" className="p-4 text-xs text-red-500">{query.error.message}</p> : query.isLoading ? <p className="p-4 text-xs">正在读取变更…</p> : query.data?.fileType ? <p className="p-4 text-xs">二进制文件或大文件不支持文本差异编辑</p> : query.data && <CodeDiffView key={`${path}:${stage}`} path={path} before={query.data.before} after={draft} editable={stage === 'working' && query.data.exists} onChange={setDraft} leftLabel={stage === 'working' ? '暂存区' : 'HEAD'} rightLabel={stage === 'working' ? '工作区' : '暂存区'}/>}</div>
  </section></div>;
}
