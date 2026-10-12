import { useEffect, useRef, useState } from 'react';

export interface BlameLine { line: number; originalLine: number; hash: string; author: string; email: string; date: number; summary: string; uncommitted: boolean }
export function useGitBlame(identity: string | undefined, path: string | undefined, content: string, request: (path: string, content: string, signal: AbortSignal) => Promise<{ lines: BlameLine[] }>) {
  const [enabled, setEnabled] = useState(false);
  const [editor, setEditor] = useState<any>();
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<BlameLine>();
  const requestRef = useRef(request); requestRef.current = request;
  const rowsRef = useRef<BlameLine[]>([]);
  useEffect(() => {
    if (!editor || editor.isDisposed?.()) return;
    const action = editor.addAction({ id: 'workspace.git-blame', label: 'Git Blame · 显示 / 隐藏行注释', contextMenuGroupId: 'navigation', contextMenuOrder: 10, run: () => setEnabled(value => !value) });
    const mouse = editor.onMouseDown((event: any) => { if (event.target.type === 3 && event.target.position) setSelected(rowsRef.current[event.target.position.lineNumber - 1]); });
    const disposed = editor.onDidDispose(() => setEditor(undefined));
    return () => { action.dispose(); mouse.dispose(); disposed.dispose(); };
  }, [editor]);
  useEffect(() => {
    if (!editor || editor.isDisposed?.()) return;
    const decorations = editor.createDecorationsCollection();
    const controller = new AbortController();
    let active = true;
    rowsRef.current = [];
    editor.updateOptions({ lineNumbers: 'on', lineNumbersMinChars: 5 });
    setStatus('');
    setSelected(undefined);
    let timer: ReturnType<typeof setTimeout>;
    if (enabled && identity && path && !path.startsWith('@java-source/')) {
      setStatus('正在加载行注释…');
      timer = setTimeout(() => {
        void requestRef.current(path, content, controller.signal).then(result => {
          if (!active || editor.getModel()?.getValue() !== content) return;
          rowsRef.current = result.lines;
          editor.updateOptions({ lineNumbersMinChars: 38, lineNumbers: (line: number) => {
            const item = rowsRef.current[line - 1];
            if (!item) return String(line);
            return item.uncommitted ? `未提交修改     ${line}` : `${item.author.slice(0, 12)} · ${new Date(item.date * 1000).toISOString().slice(0, 10)} · ${item.hash.slice(0, 7)}   ${line}`;
          } });
          decorations.set(result.lines.map(item => ({ range: { startLineNumber: item.line, startColumn: 1, endLineNumber: item.line, endColumn: 1 }, options: { isWholeLine: true, hoverMessage: { value: item.uncommitted ? '未提交修改（包含当前未保存的编辑）' : `${item.author} <${item.email}>\n\n${new Date(item.date * 1000).toLocaleString()}\n\n${item.hash}\n\n${item.summary}`, isTrusted: false, supportHtml: false } } })));
          setStatus('');
        }).catch(error => { if (active && !controller.signal.aborted) setStatus(error.response?.data?.message || error.message || '无法加载行注释'); });
      }, 450);
    } else if (enabled) setStatus('此文件不支持 Git 行注释');
    return () => { active = false; clearTimeout(timer); controller.abort(); decorations.clear(); if (!editor.isDisposed?.()) editor.updateOptions({ lineNumbers: 'on', lineNumbersMinChars: 5 }); };
  }, [editor, enabled, identity, path, content]);
  return { attach: setEditor, enabled, toggle: () => setEnabled(value => !value), status, selected, close: () => setSelected(undefined) };
}
