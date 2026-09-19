import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, HardDrive, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { Card, PageHeader, errText } from './ui';

interface Location { host: string; projectsRoot: string; workspacesRoot: string }
interface StorageConfig {
  active: Location;
  target: Location | null;
  targetUpdatedAt: string | null;
  totalProjects: number;
  projects: Array<{ id: string; name: string; status: string; path: string | null; exists: boolean; legacyPath: string | null }>;
  note: string;
}

export function WorkspaceStoragePage() {
  const queryClient = useQueryClient();
  const query = useQuery<StorageConfig>({ queryKey: ['workspace-storage-config'], queryFn: async () => (await api.get('/workspace-storage/config')).data });
  const [draft, setDraft] = useState<Location>({ host: '', projectsRoot: '', workspacesRoot: '' });
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (query.data) setDraft(query.data.target || query.data.active);
  }, [query.data]);
  const save = useMutation({
    mutationFn: async () => (await api.put('/workspace-storage/config', draft)).data as StorageConfig,
    onSuccess: (data) => { queryClient.setQueryData(['workspace-storage-config'], data); setMessage('迁移目标已保存；当前项目路径未切换。'); },
    onError: (error) => setMessage(`保存失败：${errText(error)}`),
  });
  const data = query.data;
  const pending = !!data?.target && (data.target.host !== data.active.host || data.target.projectsRoot !== data.active.projectsRoot || data.target.workspacesRoot !== data.active.workspacesRoot);
  return <div>
    <PageHeader title="项目存储路径" desc="查看当前节点实际使用的项目目录，并登记统一共享存储的迁移目标。" />
    {query.isError && <p className="mb-4 text-sm text-red-600">读取路径失败：{errText(query.error)}</p>}
    <div className="space-y-5">
      <Card title="当前生效路径">
        <div className="grid gap-4 md:grid-cols-2">
          <PathValue label="所在主机" value={data?.active.host} />
          <PathValue label="项目基础路径" value={data?.active.projectsRoot} />
          <PathValue label="协作者工作区路径" value={data?.active.workspacesRoot} />
          <div className="flex items-center gap-2 text-sm text-muted"><HardDrive size={16} />数据库记录 {data?.totalProjects ?? '—'} 个项目</div>
        </div>
      </Card>
      <Card title="配置迁移目标">
        <p className="mb-4 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"><TriangleAlert size={16} className="shrink-0" />保存这里只登记目标路径，不会移动文件或改变正在使用的工作区。迁移必须先冻结项目写入、复制并校验每个项目及 Git worktree，再统一切换所有节点。</p>
        <div className="grid gap-4 md:grid-cols-2">
          <PathInput label="共享存储主机 / IP" value={draft.host} onChange={(host) => setDraft({ ...draft, host })} />
          <PathInput label="项目基础路径（绝对路径）" value={draft.projectsRoot} onChange={(projectsRoot) => setDraft({ ...draft, projectsRoot })} />
          <PathInput label="协作者工作区路径（绝对路径）" value={draft.workspacesRoot} onChange={(workspacesRoot) => setDraft({ ...draft, workspacesRoot })} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3"><button className="btn btn-primary" disabled={save.isPending || !draft.host.trim() || !draft.projectsRoot.trim() || !draft.workspacesRoot.trim()} onClick={() => save.mutate()}>{save.isPending ? '保存中…' : '保存迁移目标'}</button>{pending && <span className="text-xs text-amber-700 dark:text-amber-300">已登记待迁移目标，当前仍使用上方路径</span>}{message && <span className="text-xs text-muted">{message}</span>}</div>
      </Card>
      <Card title="项目实际位置">
        <p className="mb-3 text-xs text-muted">从项目的逻辑存储位置与当前生效根路径计算。这里仅显示，不会创建目录或修改文件。</p>
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {data?.projects.map((project) => <div key={project.id} className="rounded-xl border border-slate-200/80 p-3 text-xs dark:border-slate-800"><div className="flex items-center gap-2"><FolderGit2 size={14} className="text-indigo-500" /><b>{project.name}</b><span className="text-muted">{project.status}</span><span className={`ml-auto ${project.exists ? 'text-emerald-600' : 'text-amber-600'}`}>{project.exists ? '目录存在' : '目录缺失'}</span></div><div className="mt-2 break-all font-mono text-[11px]">{project.path || '存储位置无效'}</div>{project.legacyPath && <div className="mt-1 break-all text-[11px] text-muted">旧记录：{project.legacyPath}</div>}</div>)}
          {!data?.projects.length && <p className="py-6 text-center text-xs text-muted">暂无项目记录</p>}
        </div>
        {!!data && data.totalProjects > data.projects.length && <p className="mt-3 text-xs text-muted">当前仅展示最近 {data.projects.length} 个项目。</p>}
      </Card>
    </div>
  </div>;
}

function PathValue({ label, value }: { label: string; value?: string }) {
  return <div><div className="mb-1 text-xs text-muted">{label}</div><div className="break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs dark:bg-slate-800">{value || '读取中…'}</div></div>;
}

function PathInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block"><span className="label mb-1.5">{label}</span><input className="input font-mono text-xs" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
