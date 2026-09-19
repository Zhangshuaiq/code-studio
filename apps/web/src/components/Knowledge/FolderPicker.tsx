import { useState, type ReactNode } from "react";
import { Folder, FolderOpen, X } from "lucide-react";
import type { KnowledgeFolder } from "../../hooks/useKnowledge";

export function FolderPicker({ folders, currentId, teamName, onCancel, onConfirm, pending }: {
  folders: KnowledgeFolder[];
  currentId?: string | null;
  teamName: string;
  onCancel: () => void;
  onConfirm: (folderId: string | null) => void;
  pending?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(currentId || null);
  const render = (parentId: string | null, depth: number): ReactNode =>
    folders.filter(item => (item.parentId || null) === parentId).map(folder => (
      <div key={folder.id}>
        <button type="button" onClick={() => setSelected(folder.id)}
          className={`flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-xs ${selected === folder.id ? "bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : "hover:bg-slate-50 dark:hover:bg-slate-800"}`}
          style={{ paddingLeft: 10 + depth * 16 }}>
          {selected === folder.id ? <FolderOpen size={14} /> : <Folder size={14} className="text-amber-500" />}
          <span className="truncate">{folder.name}</span>
        </button>
        {render(folder.id, depth + 1)}
      </div>
    ));
  return <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/50 p-4">
    <div role="dialog" aria-modal="true" aria-labelledby="move-document-title" className="card w-full max-w-md overflow-hidden">
      <div className="flex items-center justify-between border-b px-5 py-4 dark:border-slate-800"><div><h2 id="move-document-title" className="text-base font-semibold">移动至</h2><p className="mt-1 text-xs text-muted">选择“{teamName}”知识库中的目标文件夹</p></div><button type="button" className="icon-btn" aria-label="关闭" onClick={onCancel}><X size={16} /></button></div>
      <div className="max-h-[50vh] overflow-y-auto p-3"><button type="button" onClick={() => setSelected(null)} className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs ${selected === null ? "bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : "hover:bg-slate-50 dark:hover:bg-slate-800"}`}><FolderOpen size={14} />知识库根目录</button>{render(null, 0)}</div>
      <div className="flex justify-end gap-2 border-t px-5 py-4 dark:border-slate-800"><button type="button" className="btn btn-ghost" onClick={onCancel}>取消</button><button type="button" className="btn btn-primary" disabled={pending || selected === (currentId || null)} onClick={() => onConfirm(selected)}>{pending ? "移动中…" : "确认移动"}</button></div>
    </div>
  </div>;
}
