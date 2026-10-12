import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DiffEditor } from '@monaco-editor/react';
import type { BlameLine } from '../../hooks/useGitBlame';
import { useTheme } from '../../store/theme';
interface Change { path: string; before: string; after: string; fileType?: string }
export function GitBlameDetails({ item: activeItem, onClose, load }: { item?: BlameLine; onClose: () => void; load: (hash: string, signal: AbortSignal) => Promise<Change[]> }) {
  const item = activeItem || { uncommitted: true, summary: '', author: '', email: '', date: 0, hash: '' };
  const [hasDiff, setHasDiff] = useState(false);
  const [changes, setChanges] = useState<Change[]>([]);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState('');
  const theme = useTheme(state => state.theme);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    const controller = new AbortController();
    setChanges([]); setSelected(0); setStatus('');
    if (activeItem && !activeItem.uncommitted) {
      setStatus('正在加载提交改动…');
      void loadRef.current(activeItem.hash, controller.signal).then(result => { if (!controller.signal.aborted) { setChanges(result); setHasDiff(true); setStatus(result.length ? '' : '此提交在当前工作区内没有文件改动'); } }).catch(error => { if (!controller.signal.aborted) setStatus(error.response?.data?.message || error.message || '无法加载提交改动'); });
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    if (activeItem) window.addEventListener('keydown', key);
    return () => { controller.abort(); window.removeEventListener('keydown', key); };
  }, [activeItem]);
  const change = changes[selected];
  // Monaco 0.56 stores a global hover factory bound to the last created
  // standalone editor's child service. Disposing a transient diff editor
  // breaks subsequent reference peek widgets in the still-alive main editor.
  // Keep the diff instance alive for the workspace lifetime, but clear its
  // models on close and hide the dialog (no retained commit source contents).
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-8" style={{ display: activeItem ? undefined : 'none' }} role={activeItem ? 'dialog' : undefined} aria-modal={activeItem ? true : undefined} aria-label={activeItem ? '行注释提交详情' : undefined} onClick={onClose}>
    <div className="flex h-[75vh] w-[85vw] flex-col overflow-hidden rounded-xl border bg-white shadow-xl dark:bg-slate-900" onClick={event => event.stopPropagation()}>
      <div className="flex items-start gap-4 border-b p-4"><div className="min-w-0 flex-1 text-xs"><div className="font-semibold">{item.uncommitted ? '未提交修改' : item.summary}</div>{!item.uncommitted && <><div className="mt-2">{item.author} &lt;{item.email}&gt; · {new Date(item.date * 1000).toLocaleString()}</div><div className="mt-1 select-all font-mono">{item.hash}</div></>}</div><button className="btn btn-sm" onClick={onClose}>关闭</button></div>
      {item.uncommitted ? <p className="p-4 text-sm">此行包含未提交或未保存的修改，没有对应的历史提交。</p> : <><div className="flex max-h-24 flex-wrap gap-2 overflow-auto p-2">{changes.map((file, index) => <button key={file.path} className={`btn btn-sm ${index === selected ? 'text-indigo-600' : ''}`} onClick={() => setSelected(index)}>{file.path}</button>)}</div>{status && <p role="status" className="p-4 text-xs">{status}</p>}{change?.fileType && <p className="p-4 text-xs">该文件不支持文本差异预览</p>}</>}
      <div className="min-h-0 flex-1" style={{ visibility: item.uncommitted || !change || change.fileType ? 'hidden' : undefined }}>{hasDiff && <DiffEditor original={change?.fileType ? '' : change?.before || ''} modified={change?.fileType ? '' : change?.after || ''} theme={theme === 'dark' ? 'vs-dark' : 'light'} options={{ readOnly: true, automaticLayout: true, fontSize: 12, minimap: { enabled: false } }} />}</div>
    </div>
  </div>, document.body);
}
