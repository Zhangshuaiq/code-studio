import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings2, X } from 'lucide-react';
import { Select } from '../common/Select';
import { useEditorPreferences } from '../../store/editorPreferences';
import { defaultAppearance, presetThemes, exportAppearance, importAppearance, type EditorAppearance } from '../../lib/editor-appearance';
import { useTheme } from '../../store/theme';
import { DesktopFontPicker } from './DesktopFontPicker';
export function EditorAppearanceSettings() {
  const [open, setOpen] = useState(false); const [error, setError] = useState(''); const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null); const previousFocus = useRef<HTMLElement | null>(null);
  const close = () => { setOpen(false); queueMicrotask(() => previousFocus.current?.focus()); };
  useEffect(() => {
    if (!open) return;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),[tabindex="0"]')].filter(item => item.offsetParent !== null);
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap); return () => document.removeEventListener('keydown', trap);
  }, [open]);
  const { appearance, setAppearance } = useEditorPreferences();
  const uiTheme = useTheme(state => state.theme);
  const dark = ['dark','darcula','contrast'].includes(appearance.theme) || (appearance.theme === 'auto' && uiTheme === 'dark');
  const palette: NonNullable<EditorAppearance['customTheme']> = appearance.theme === 'custom' && appearance.customTheme ? appearance.customTheme : presetThemes[appearance.theme] || (appearance.theme === 'contrast' ? { base: 'hc-black', inherit: true, rules: [], colors: { 'editor.background': '#000000', 'editor.foreground': '#ffffff' } } : { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: { 'editor.background': dark ? '#1e1e1e' : '#ffffff', 'editor.foreground': dark ? '#d4d4d4' : '#000000', 'editor.selectionBackground': dark ? '#264f78' : '#add6ff' } });
  const colorValues: Record<string, string> = { ...palette.colors, ...Object.fromEntries(['keyword','string','comment','number'].map(token => { const value = palette.rules.find(rule => rule.token === token)?.foreground; return [token, value ? '#' + value : '']; })) };
  const [colors, setColors] = useState(colorValues);
  useEffect(() => { setColors(colorValues); }, [appearance.theme, appearance.customTheme, uiTheme]);
  const changeColor = (key: string, value: string) => {
    setColors(current => ({ ...current, [key]: value }));
    if (!/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/.test(value)) return;
    if (key.startsWith('editor.')) update({ theme: 'custom', customTheme: { ...palette, colors: { ...palette.colors, [key]: value } } });
    else update({ theme: 'custom', customTheme: { ...palette, rules: [...palette.rules.filter(rule => rule.token !== key && !rule.token.startsWith(key + '.')), { ...(palette.rules.find(rule => rule.token === key) || {}), token: key, foreground: value.slice(1) }] } });
  };
  const [fields, setFields] = useState({ fontSize: String(appearance.fontSize), lineHeight: String(appearance.lineHeight), fontFamily: appearance.fontFamily });
  useEffect(() => { setFields({ fontSize: String(appearance.fontSize), lineHeight: String(appearance.lineHeight), fontFamily: appearance.fontFamily }); }, [appearance.fontSize, appearance.lineHeight, appearance.fontFamily]);
  useEffect(() => { const handler = (event: Event) => setError((event as CustomEvent<string>).detail); window.addEventListener('code-studio:preferences-error', handler); return () => window.removeEventListener('code-studio:preferences-error', handler); }, []);
  const update = (patch: Partial<EditorAppearance>) => { try { setAppearance({ ...appearance, ...patch }); setError(''); } catch (reason) { setError((reason as Error).message); } };
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportAppearance(appearance)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'code-studio-editor-style.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <>
    <button type="button" className="icon-btn" title="编辑器外观" aria-label="编辑器外观" onClick={() => { previousFocus.current = document.activeElement as HTMLElement; setOpen(true); }}><Settings2 size={15} /></button>
    {open && createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); } }}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="editor-appearance-title" className="card max-h-[85vh] w-full max-w-lg overflow-auto p-5" data-editor-appearance>
        <header className="mb-4 flex items-center justify-between"><h2 id="editor-appearance-title" className="font-semibold">编辑器外观</h2><button className="icon-btn" aria-label="关闭编辑器外观" onClick={close} autoFocus><X size={16} /></button></header>
        <p className="mb-4 text-xs text-muted">修改即时生效并自动保存；编辑器与终端配色同步，不改变页面主题。</p>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <label>字号（8–40）<input aria-label="编辑器字号" className="input mt-1 w-full" type="number" min={8} max={40} value={fields.fontSize} onChange={e => { setFields({ ...fields, fontSize: e.target.value }); const value = Number(e.target.value); if (Number.isInteger(value) && value >= 8 && value <= 40) update({ fontSize: value }); }} onBlur={() => { update({ fontSize: Number(fields.fontSize) }); setFields(current => ({ ...current, fontSize: String(appearance.fontSize) })); }} /></label>
          <label>行高（12–80）<input aria-label="编辑器行高" className="input mt-1 w-full" type="number" min={12} max={80} value={fields.lineHeight} onChange={e => { setFields({ ...fields, lineHeight: e.target.value }); const value = Number(e.target.value); if (Number.isInteger(value) && value >= 12 && value <= 80) update({ lineHeight: value }); }} onBlur={() => { update({ lineHeight: Number(fields.lineHeight) }); setFields(current => ({ ...current, lineHeight: String(appearance.lineHeight) })); }} /></label>
          {import.meta.env.VITE_RUNTIME_MODE === 'desktop-local' ? <DesktopFontPicker value={appearance.fontFamily} onChange={fontFamily => update({ fontFamily })} /> : <label className="col-span-2">字体类型<input aria-label="编辑器字体" className="input mt-1 w-full font-mono" value={fields.fontFamily} onChange={e => { setFields({ ...fields, fontFamily: e.target.value }); if (e.target.value.trim()) update({ fontFamily: e.target.value }); }} onBlur={() => { update({ fontFamily: fields.fontFamily }); setFields(current => ({ ...current, fontFamily: appearance.fontFamily })); }} /><span className="mt-1 block text-muted">填写本机已安装字体，可用逗号配置回退字体。</span></label>}
          <label>主题<Select value={appearance.theme} ariaLabel="编辑器主题" onChange={value => update({ theme: value as EditorAppearance['theme'] })} options={[{ value: 'auto', label: '跟随页面' }, { value: 'idea', label: 'IDEA 浅色' }, { value: 'darcula', label: 'Darcula' }, ...Object.entries({ 'xcode-light': 'Xcode 浅色', 'xcode-dark': 'Xcode 深色', 'jetbrains-light': 'JetBrains 浅色', 'jetbrains-dark': 'JetBrains 深色', 'github-light': 'GitHub 浅色', 'github-dark': 'GitHub 深色', 'material-default': 'Material 经典', 'material-ocean': 'Material Ocean', 'material-darker': 'Material Darker', 'material-palenight': 'Material Palenight', 'material-light': 'Material 浅色' }).map(([value, label]) => ({ value, label })), { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'contrast', label: '高对比度' }, ...(appearance.customTheme ? [{ value: 'custom', label: '自定义主题' }] : [])]} /></label>
          <label>自动换行<Select value={appearance.wordWrap} ariaLabel="编辑器自动换行" onChange={value => update({ wordWrap: value as 'off' | 'on' })} options={[{ value: 'off', label: '关闭' }, { value: 'on', label: '打开' }]} /></label>
          {(['fontLigatures','minimap','lineNumbers'] as const).map((key, index) => <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={appearance[key]} onChange={e => update({ [key]: e.target.checked })} />{['字体连字','代码缩略图','行号'][index]}</label>)}
        </div>
        <details className="mt-4 rounded-lg border p-3 text-xs dark:border-slate-700"><summary className="cursor-pointer font-medium">自定义颜色</summary><div className="mt-3 grid grid-cols-2 gap-3">
          {[['editor.background','编辑器背景'],['editor.foreground','编辑器正文'],['editor.selectionBackground','选区背景'],['keyword','关键字'],['string','字符串'],['comment','注释'],['number','数字']].map(([key,label]) => <label key={key}>{label}<div className="mt-1 flex items-center gap-2"><span className="h-5 w-5 shrink-0 rounded border" style={{ backgroundColor: colorValues[key] || 'transparent' }} /><input aria-label={label+'颜色'} className="input min-w-0 font-mono text-xs" value={colors[key] || ''} placeholder="继承主题" maxLength={9} onChange={event => changeColor(key,event.target.value)} onBlur={() => { if ((colors[key] || '') !== (colorValues[key] || '') && !/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/.test(colors[key] || '')) { setError('颜色必须为 #RRGGBB 或 #RRGGBBAA'); setColors(current => ({ ...current, [key]: colorValues[key] })); } }} /></div></label>)}
        </div><p className="mt-2 text-muted">调整后自动使用自定义主题，不修改页面背景。</p></details>
        {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
        <p className="mt-4 text-xs text-muted">导入 JSON 样式配置或 Monaco 主题（base、rules、colors），最大 128 KiB。不会执行 CSS、脚本或下载外部字体。</p>
        <input ref={input} type="file" accept=".json,application/json" className="hidden" aria-label="导入编辑器样式文件" onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; try { if (file.size > 128 * 1024) throw Error('样式文件最多 128 KiB'); setAppearance(importAppearance(await file.text())); setError(''); } catch (reason) { setError((reason as Error).message); } }} />
        <footer className="mt-4 flex flex-wrap gap-2"><button className="btn btn-secondary btn-sm" onClick={() => input.current?.click()}>导入样式</button><button className="btn btn-secondary btn-sm" onClick={download}>导出当前样式</button><button className="btn btn-ghost btn-sm" onClick={() => { setAppearance(defaultAppearance); setError(''); }}>恢复默认</button></footer>
      </section>
    </div>, document.body)}
  </>;
}
