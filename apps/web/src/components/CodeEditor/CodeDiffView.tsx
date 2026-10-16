import { useEffect, useRef, useState } from 'react';
import { DiffEditor, useMonaco } from '@monaco-editor/react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { monacoLang } from '../../lib/monaco';
import { useTheme } from '../../store/theme';
import { useEditorAppearance } from '../../hooks/useEditorAppearance';

export function CodeDiffView({ path, before, after, editable = false, onChange, leftLabel = '原始版本', rightLabel = '当前版本' }: {
  path: string; before: string; after: string; editable?: boolean; onChange?: (value: string) => void; leftLabel?: string; rightLabel?: string;
}) {
  const monaco = useMonaco(), theme = useTheme(state => state.theme);
  const appearance = useEditorAppearance(monaco, theme);
  const editor = useRef<any>(), cleanup = useRef<() => void>(), changed = useRef(onChange); changed.current = onChange;
  const [count, setCount] = useState(0), [current, setCurrent] = useState(0);
  const applyRef = useRef<(index?: number) => void>(() => {});
  useEffect(() => () => cleanup.current?.(), []);
  const move = (direction: number) => {
    const changes = editor.current?.getLineChanges() || []; if (!changes.length) return;
    const index = (current + direction + changes.length) % changes.length, change = changes[index]; setCurrent(index);
    editor.current.getOriginalEditor().revealLineInCenter(Math.max(1, change.originalStartLineNumber));
    editor.current.getModifiedEditor().revealLineInCenter(Math.max(1, change.modifiedStartLineNumber));
  };
  const revert = (index = current) => {
    const instance = editor.current, change = instance?.getLineChanges()?.[index]; if (!instance || !change || !editable || !monaco) return;
    const original = instance.getOriginalEditor().getModel(), modified = instance.getModifiedEditor().getModel(); if (!original || !modified) return;
    const source = change.originalEndLineNumber === 0 ? '' : original.getLinesContent().slice(change.originalStartLineNumber - 1, change.originalEndLineNumber).join('\n');
    const start = change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber + 1 : change.modifiedStartLineNumber;
    const end = change.modifiedEndLineNumber === 0 ? start : change.modifiedEndLineNumber + 1;
    let target, text;
    if (end <= modified.getLineCount()) { target = new monaco.Range(start, 1, end, 1); text = source ? source + '\n' : ''; }
    else if (start > 1) { target = new monaco.Range(start - 1, modified.getLineMaxColumn(start - 1), modified.getLineCount(), modified.getLineMaxColumn(modified.getLineCount())); text = source ? '\n' + source : ''; }
    else { target = modified.getFullModelRange(); text = source; }
    const targetEditor = instance.getModifiedEditor(); targetEditor.pushUndoStop(); targetEditor.executeEdits('git-apply-left-hunk', [{range:target,text}]); targetEditor.pushUndoStop();
  };
  applyRef.current = revert;
  return <div className="flex h-full min-h-0 flex-col" data-code-diff-view>
    <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
      <span className="min-w-0 flex-1 truncate" title={leftLabel}>{leftLabel}</span>
      <button className="icon-btn" aria-label="上一处差异" disabled={!count} onClick={() => move(-1)}><ArrowUp size={14}/></button>
      <span className="min-w-12 text-center text-muted">{count ? Math.min(current + 1, count) : 0}/{count}</span>
      <button className="icon-btn" aria-label="下一处差异" disabled={!count} onClick={() => move(1)}><ArrowDown size={14}/></button>
      {editable && <button className="btn btn-secondary btn-sm" aria-label="将当前差异从左侧应用到右侧" disabled={!count} onClick={() => revert()}>→ 应用当前块</button>}
      <span className="min-w-0 flex-1 truncate text-right" title={rightLabel}>{rightLabel}{editable ? ' · 可编辑草稿' : ' · 只读'}</span>
    </header>
    <div className="min-h-0 flex-1"><DiffEditor language={monacoLang(path)} original={before} modified={after} theme={appearance.editorTheme}
      onMount={instance => {
        cleanup.current?.(); editor.current = instance;
        const markers = instance.getModifiedEditor().createDecorationsCollection();
        const refresh = () => { const changes = instance.getLineChanges() || [], n = changes.length; setCount(n); setCurrent(index => Math.min(index, Math.max(0, n - 1))); markers.set(editable ? changes.map(change => ({ range: {startLineNumber:Math.max(1,change.modifiedStartLineNumber),endLineNumber:Math.max(1,change.modifiedStartLineNumber),startColumn:1,endColumn:1}, options:{glyphMarginClassName:'git-diff-apply-left',glyphMarginHoverMessage:{value:'点击将左侧此块应用到右侧草稿'}} })) : []); };
        const diff = instance.onDidUpdateDiff(refresh), edit = instance.getModifiedEditor().onDidChangeModelContent(() => changed.current?.(instance.getModifiedEditor().getValue()));
        const click = instance.getModifiedEditor().onMouseDown(event => { if(event.target.type !== 2 || event.event.browserEvent.button !== 0 || !(event.event.browserEvent.target as HTMLElement)?.closest?.('.git-diff-apply-left')) return; const index = (instance.getLineChanges() || []).findIndex(change => Math.max(1,change.modifiedStartLineNumber) === event.target.position?.lineNumber); if(index >= 0) applyRef.current(index); });
        cleanup.current = () => { diff.dispose(); edit.dispose(); click.dispose(); markers.clear(); }; refresh();
      }}
      options={{ ...appearance.appearanceOptions, glyphMargin: editable, readOnly: !editable, originalEditable: false, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false, enableSplitViewResizing: true, renderMarginRevertIcon: editable, ignoreTrimWhitespace: false, automaticLayout: true, scrollBeyondLastLine: false, minimap: { enabled: false } }} /></div>
    {editable && <p className="border-t px-3 py-1 text-[10px] text-muted">点击差异旁的箭头，将左侧变更应用到右侧草稿；支持撤销，保存前不写入文件。</p>}
  </div>;
}
