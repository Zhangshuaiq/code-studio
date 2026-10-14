import { useEffect, useRef, useState } from 'react';

type FontWindow = Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> };
let cachedFamilies: string[] = [];

export function DesktopFontPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [families, setFamilies] = useState(cachedFamilies);
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async () => {
    setLoading(true); setError('');
    try {
      const query = (window as FontWindow).queryLocalFonts;
      if (!query) throw Error('当前客户端不支持读取系统字体，请更新客户端。');
      const fonts = await query.call(window);
      const result = [...new Set(fonts.map(font => font.family.trim()).filter(name => name && name.length < 200 && !/[\u0000-\u001f;{}<>]/.test(name)))].sort((a, b) => a.localeCompare(b));
      if (!result.length) throw Error('未读取到可用系统字体，请检查字体访问权限。');
      cachedFamilies = result;
      if (alive.current) setFamilies(result);
    } catch (reason) { if (alive.current) setError((reason as Error).message || '读取系统字体失败，可重试。'); }
    finally { if (alive.current) setLoading(false); }
  };
  const filtered = families.filter(name => name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <div className="col-span-2 text-xs">
    <span>字体类型</span>
    <button type="button" aria-label="编辑器字体" aria-expanded={expanded} aria-controls="desktop-font-list" className="input mt-1 flex w-full items-center justify-between text-left" onClick={() => { setExpanded(!expanded); if (!expanded && !families.length && !loading) void load(); }}>
      <span className="truncate" style={{ fontFamily: value }}>{value}</span><span className="ml-2">⌄</span>
    </button>
    {expanded && <div className="mt-2 rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); } }}>
      <div className="flex gap-2"><input autoFocus aria-label="搜索系统字体" placeholder="搜索系统字体…" className="input min-w-0 flex-1 text-xs" value={search} onChange={event => setSearch(event.target.value)} /><button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void load()}>刷新</button></div>
      {loading && <p role="status" className="p-2 text-muted">正在读取系统字体…</p>}
      {error && <p role="alert" className="p-2 text-red-500">{error}</p>}
      <div id="desktop-font-list" role="listbox" aria-label="系统字体" className="mt-2 max-h-48 overflow-auto">
        <button type="button" role="option" aria-selected={value === 'monospace'} className="w-full rounded-lg px-3 py-2 text-left hover:bg-indigo-50 dark:hover:bg-slate-800" style={{ fontFamily: 'monospace' }} onClick={() => { onChange('monospace'); setExpanded(false); }}>系统默认等宽字体</button>
        {filtered.map(name => { const family = `${JSON.stringify(name)}, monospace`; return <button key={name} type="button" role="option" aria-selected={value === family} className={`w-full rounded-lg px-3 py-2 text-left hover:bg-indigo-50 dark:hover:bg-slate-800 ${value === family ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10' : ''}`} style={{ fontFamily: family }} onClick={() => { onChange(family); setExpanded(false); }}>{name}<span className="ml-3 text-muted">Aa 0123</span></button>; })}
        {!loading && !error && families.length > 0 && !filtered.length && <p className="p-2 text-muted">未找到匹配字体</p>}
      </div>
    </div>}
    <span className="mt-1 block text-muted">从本机已安装字体中选择；安装新字体后点击刷新。选择后即时生效。</span>
  </div>;
}
