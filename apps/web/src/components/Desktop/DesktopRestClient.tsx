import { useEffect, useRef, useState } from 'react';
import { Select } from '../common/Select';
type Draft = { id: string; method: string; url: string; headers: string; params: string; body: string; mode: string };
type Endpoint = { id: string; method: string; path: string; name: string; source: string; file: string; line?: number; body: string; parameters: { name: string; in: string; value: unknown; required: boolean }[] };
const create = (): Draft => ({ id: crypto.randomUUID(), method: 'GET', url: 'http://localhost:8080', headers: '', params: '', body: '', mode: 'json' });
export function DesktopRestClient({ projectId }: { projectId: string }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => [create()]); const [selected, setSelected] = useState('');
  const draft = drafts.find(item => item.id === selected) || drafts[0];
  const [results, setResults] = useState<Record<string, any>>({}); const [busy, setBusy] = useState(''); const [errors, setErrors] = useState<Record<string, string>>({}); const controller = useRef<AbortController>();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]); const [discovering, setDiscovering] = useState(false); const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryNote, setDiscoveryNote] = useState(''); const [query, setQuery] = useState(''); const [baseUrl, setBaseUrl] = useState('http://localhost:8080');
  const discoveryController = useRef<AbortController>();
  async function discover() {
    discoveryController.current?.abort(); const cancellation = new AbortController(); discoveryController.current = cancellation;
    setDiscovering(true); setDiscoveryError('');
    try {
      const response = await fetch(`/api/local/projects/${projectId}/rest-endpoints`, { signal: cancellation.signal }); const result = await response.json();
      if (!response.ok) throw Error(result.message || '接口扫描失败');
      if (cancellation.signal.aborted) return;
      setEndpoints(result.items); setDiscoveryNote([result.truncated ? '扫描达到资源上限，列表不完整' : '', result.unresolved ? `${result.unresolved} 个动态映射无法静态确定` : '', result.skipped ? `${result.skipped} 个文件未读取或解析` : ''].filter(Boolean).join(' · '));
    } catch (error: any) { if (!cancellation.signal.aborted) setDiscoveryError(error.message || '接口扫描失败'); }
    finally { if (discoveryController.current === cancellation) setDiscovering(false); }
  }
  useEffect(() => { void discover(); return () => discoveryController.current?.abort(); }, [projectId]);
  function selectEndpoint(endpoint: Endpoint) {
    if (drafts.length >= 10) { setDiscoveryError('最多打开 10 个请求，请先关闭一个请求'); return; }
    const next = { ...create(), method: endpoint.method, url: `${baseUrl.replace(/\/+$/, '')}${endpoint.path}`, body: endpoint.body, params: endpoint.parameters.filter(p => p.in === 'query').map(p => `${p.name}=${String(p.value)}`).join('\n'), headers: endpoint.parameters.filter(p => p.in === 'header').map(p => `${p.name}: ${String(p.value)}`).join('\n') };
    setDrafts(items => [...items, next]); setSelected(next.id);
  }
  useEffect(() => () => controller.current?.abort(), []);
  const change = (patch: Partial<Draft>) => setDrafts(items => items.map(item => item.id === draft.id ? { ...item, ...patch } : item));
  async function send() {
    const id = draft.id; setBusy(id); setErrors(current => ({ ...current, [id]: '' })); const cancellation = new AbortController(); controller.current = cancellation;
    try {
      if (/\{[^}]+\}/.test(draft.url)) throw Error('请先在请求地址中填写路径参数（替换 {...}）');
      const url = new URL(draft.url); for (const row of draft.params.split('\n').filter(row => row.trim())) { const index = row.indexOf('='); if (index < 0) throw Error('查询参数每行使用 key=value'); url.searchParams.append(row.slice(0, index).trim(), row.slice(index + 1)); }
      const headers: Record<string, string> = {}; for (const row of draft.headers.split('\n').filter(row => row.trim())) { const index = row.indexOf(':'); if (index < 1) throw Error('请求头每行使用 Name: Value'); headers[row.slice(0, index).trim()] = row.slice(index + 1).trim(); }
      const body = ['GET','HEAD'].includes(draft.method) ? '' : draft.body;
      if (draft.mode === 'json' && body) { JSON.parse(body); if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'; }
      const response = await fetch(`/api/local/projects/${projectId}/rest-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.toString(), method: draft.method, headers, body }), signal: cancellation.signal });
      const result = await response.json(); if (!response.ok) throw Error(result.message || '请求失败'); setResults(current => ({ ...current, [id]: result }));
    } catch (reason: any) { setErrors(current => ({ ...current, [id]: cancellation.signal.aborted ? '请求已取消' : reason.message || '请求失败' })); }
    finally { if (controller.current === cancellation) { controller.current = undefined; setBusy(''); } }
  }
  const result = results[draft.id]; let responseBody = result?.body || ''; try { responseBody = JSON.stringify(JSON.parse(responseBody), null, 2); } catch {}
  return <div className="flex h-full min-h-0 flex-col" data-rest-client>
    <details open className="shrink-0 border-b p-3"><summary className="cursor-pointer text-xs font-semibold">项目接口 · {endpoints.length} 个</summary>
      <div className="mt-2 flex gap-2"><input aria-label="接口基础地址" className="input min-w-0 flex-1 text-xs" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /><input aria-label="搜索项目接口" placeholder="搜索路径、方法、Controller" className="input min-w-0 flex-1 text-xs" value={query} onChange={event => setQuery(event.target.value)} /><button className="btn btn-sm btn-secondary" disabled={discovering} onClick={() => void discover()}>{discovering ? '正在扫描…' : '刷新接口'}</button></div>
      {(discoveryError || discoveryNote) && <p className="mt-2 text-xs text-amber-600">{discoveryError || discoveryNote}</p>}
      <div className="mt-2 max-h-48 overflow-auto">{endpoints.filter(item => `${item.method} ${item.path} ${item.name}`.toLowerCase().includes(query.toLowerCase())).map(item => <button key={item.id} className="flex w-full gap-2 rounded px-2 py-1 text-left text-xs hover:bg-primary/10" title={`${item.file}${item.line ? `:${item.line}` : ''}`} onClick={() => selectEndpoint(item)}><span className="w-16 shrink-0 font-mono text-primary">{item.method}</span><span className="min-w-0 flex-1 truncate font-mono">{item.path}</span><span className="max-w-[40%] truncate text-muted">{item.name}</span></button>)}{!discovering && !endpoints.length && <p className="py-2 text-xs text-muted">未发现接口。当前支持 Spring Controller 注解与 OpenAPI/Swagger JSON；动态路由仍可手动填写。</p>}</div>
      <p className="mt-1 text-xs text-muted">选择接口仅创建请求草稿。基础地址包含网关或项目上下文路径；路径参数和请求体请核对后发送。</p>
    </details>
    <div className="flex gap-1 overflow-auto border-b p-2">{drafts.map((item, index) => <button key={item.id} className={`btn btn-sm ${item.id === draft.id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setSelected(item.id)}>{item.method} 请求 {index + 1}</button>)}<button className="btn btn-ghost btn-sm" disabled={drafts.length >= 10} onClick={() => { const next = create(); setDrafts(items => [...items, next]); setSelected(next.id); }}>＋请求</button><button className="btn btn-ghost btn-sm ml-auto" disabled={drafts.length <= 1 || busy === draft.id} onClick={() => { setDrafts(items => items.filter(item => item.id !== draft.id)); setSelected(''); }}>关闭请求</button></div>
    <div className="flex items-center gap-2 p-3"><Select ariaLabel="HTTP 请求方法" className="w-28 shrink-0" value={draft.method} options={['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map(value => ({ value, label: value }))} onChange={method => change({ method })} /><input aria-label="HTTP 请求地址" className="input min-w-0 flex-1" value={draft.url} onChange={event => change({ url: event.target.value })} /><button className="btn btn-primary" disabled={!!busy} onClick={() => void send()}>发送</button>{busy && <button className="btn btn-secondary" onClick={() => controller.current?.abort()}>取消</button>}</div>
    <p className="px-3 text-xs text-muted">请求从本机发送；POST/PUT/PATCH/DELETE 可能修改远端数据。请求及凭据仅保留在当前工作区内存中。</p>
    {errors[draft.id] && <p role="alert" className="p-3 text-xs text-red-500">{errors[draft.id]}</p>}
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto p-3"><section className="space-y-3"><label className="block text-xs">查询参数（每行 key=value）<textarea aria-label="HTTP 查询参数" className="input mt-1 h-20 w-full font-mono text-xs" value={draft.params} onChange={event => change({ params: event.target.value })} /></label><label className="block text-xs">请求头（每行 Name: Value，支持 Authorization）<textarea aria-label="HTTP 请求头" className="input mt-1 h-24 w-full font-mono text-xs" value={draft.headers} onChange={event => change({ headers: event.target.value })} /></label><div className="flex items-center gap-2 text-xs">请求体<Select ariaLabel="HTTP 请求体格式" value={draft.mode} options={[{ value: 'json', label: 'JSON' }, { value: 'text', label: '文本' }]} onChange={mode => change({ mode })} /></div><textarea aria-label="HTTP 请求体" disabled={['GET','HEAD'].includes(draft.method)} className="input min-h-48 w-full font-mono text-xs" value={draft.body} onChange={event => change({ body: event.target.value })} /></section><section className="min-w-0 rounded-xl border p-3 text-xs dark:border-slate-700">{result ? <><p className="mb-3 font-semibold">{result.status} {result.statusText} · {result.elapsedMs} ms · {result.bytes} bytes</p>{result.truncated && <p className="text-amber-600">响应超过 2 MiB，仅展示前 2 MiB。</p>}{result.redirected && <p className="text-muted">重定向未自动跟随，请核对 Location 后再请求。</p>}<details><summary>响应头</summary><pre className="overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(result.headers, null, 2)}</pre></details><pre className="mt-3 overflow-auto whitespace-pre-wrap break-words">{result.binary ? '二进制响应暂不预览' : responseBody}</pre></> : <p className="text-muted">发送请求后在此查看响应</p>}</section></div>
  </div>;
}
