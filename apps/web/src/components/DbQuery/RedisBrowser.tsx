import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { Select } from '../common/Select';

interface RedisKey { key: string; keyEncoding: 'utf8' | 'base64'; bytes: number }
export type RedisBrowseRequest = (input: Record<string, unknown>, signal: AbortSignal) => Promise<any>;
type RedisEditorAction = 'create' | 'edit' | 'hash-create' | 'hash-edit' | 'set-create' | 'zset-create' | 'zset-edit' | 'list-push' | 'list-edit';
export function RedisBrowser({ request, mutate }: { request: RedisBrowseRequest; mutate?: RedisBrowseRequest }) {
  const [seconds, setSeconds] = useState('3600'); const [mutating, setMutating] = useState(false);
  const mutation = useRef<AbortController>();
  const [canWrite, setCanWrite] = useState(false);
  const [editor, setEditor] = useState<{ action: RedisEditorAction; key: string; keyEncoding: 'utf8' | 'base64'; field?: string; fieldEncoding?: 'utf8' | 'base64'; member?: string; memberEncoding?: 'utf8' | 'base64'; score?: string; originalScore?: string; index?: number; expectedLength?: number; side?: 'left' | 'right'; value: string; valueEncoding: 'utf8' | 'base64'; version?: string; baseline?: string; baselineEncoding?: string }>();
  const memberEditor = !!editor && /^(?:set|zset)-/.test(editor.action);
  const dirtyValue = !!editor && (memberEditor ? editor.action.endsWith('create') ? !!editor.member || (!!editor.score && editor.score !== '0') : editor.score !== editor.originalScore : editor.action === 'list-push' ? !!editor.value || editor.valueEncoding !== 'utf8' || editor.side !== 'right' : editor.action.endsWith('create') ? !!editor.field || !!editor.value || (editor.action === 'create' && !!editor.key) : editor.value !== editor.baseline || editor.valueEncoding !== editor.baselineEncoding);
  useEffect(() => {
    if (!dirtyValue) return;
    const check = (event: Event) => { const detail = (event as CustomEvent<{ dirty: boolean }>).detail; if (detail) detail.dirty = true; };
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('code-studio:quit-check', check); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('code-studio:quit-check', check); window.removeEventListener('beforeunload', unload); };
  }, [dirtyValue]);
  const [pattern, setPattern] = useState('*'); const [items, setItems] = useState<RedisKey[]>([]);
  const [cursor, setCursor] = useState('0'); const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false); const [detailBusy, setDetailBusy] = useState(false);
  const [selected, setSelected] = useState<RedisKey>(); const [detail, setDetail] = useState<any>();
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const scan = useRef<AbortController>(); const preview = useRef<AbortController>();
  const live = useRef(true); const match = useRef('*');
  const identity = (item: RedisKey) => `${item.keyEncoding}:${item.key}`;
  async function load(reset: boolean) {
    scan.current?.abort(); const controller = new AbortController(); scan.current = controller;
    preview.current?.abort(); setDetailBusy(false); setSelected(undefined); setDetail(undefined);
    if (reset) { match.current = pattern || '*'; setItems([]); setStarted(false); setCursor('0'); }
    setBusy(true); setError('');
    try {
      const page = await request({ action: 'scan', cursor: reset ? '0' : cursor, match: match.current, count: 50 }, controller.signal);
      if (controller.signal.aborted || !live.current) return;
      setCanWrite(page.canWriteRedis === true);
      setItems([...new Map(page.items.map((item: RedisKey) => [identity(item), item])).values()] as RedisKey[]);
      setCursor(page.cursor); setStarted(true);
      if (page.partial) setNotice('本轮有过大的键名或结果未展示，请缩小匹配范围。'); else if (reset) setNotice('');
    } catch (reason: any) { if (!controller.signal.aborted && live.current) { setItems([]); preview.current?.abort(); setSelected(undefined); setDetail(undefined); setDetailBusy(false); setError(reason?.response?.data?.message || reason.message || '无法读取 Redis 键'); } }
    finally { if (!controller.signal.aborted && live.current) setBusy(false); }
  }
  async function inspect(item: RedisKey, offset = 0, collection?: { cursor: string; scanOffset: number }) {
    preview.current?.abort(); const controller = new AbortController(); preview.current = controller;
    setSelected(item); setDetailBusy(true); setError(''); if (!offset) setDetail(undefined);
    try {
      const value = await request({ action: 'value', key: item.key, keyEncoding: item.keyEncoding, offset, ...(collection || {}) }, controller.signal);
      if (!controller.signal.aborted && live.current) setDetail(value);
    } catch (reason: any) { if (!controller.signal.aborted && live.current) {
      setDetail(undefined);
      if ([401, 403, 409].includes(reason?.response?.status || reason?.status)) { setItems([]); setSelected(undefined); setCursor('0'); setStarted(false); }
      setError(reason?.response?.data?.message || reason.message || '无法读取 Redis 值');
    } }
    finally { if (!controller.signal.aborted && live.current) setDetailBusy(false); }
  }
  async function modify(action: 'delete' | 'expire' | 'persist') {
    if (!selected || !detail?.exists || !mutate) return;
    const ttl = Number(seconds);
    if (action === 'expire' && (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 2147483647)) { setError('请输入有效 TTL 秒数'); return; }
    if (!window.confirm(`确认${action === 'delete' ? '删除' : action === 'expire' ? '设置过期时间' : '移除过期时间'}：${selected.key.slice(0, 80)}？`)) return;
    const controller = new AbortController(); mutation.current = controller; setMutating(true); setError('');
    const item = selected;
    try {
      await mutate({ action, key: item.key, keyEncoding: item.keyEncoding, expectedType: detail.type, ...(action === 'expire' ? { seconds: ttl } : {}), confirm: true }, controller.signal);
      if (!controller.signal.aborted && live.current) { if (action === 'delete') await load(true); else await inspect(item); }
    } catch (reason: any) { if (!controller.signal.aborted && live.current) { setDetail(undefined); setError(reason?.response?.data?.message || reason.message || '修改失败'); } }
    finally { if (!controller.signal.aborted && live.current) setMutating(false); }
  }
  async function saveValue() {
    if (!editor || !mutate) return;
    const operation = editor.action === 'list-push' ? editor.side === 'left' ? '从头部新增列表项' : '从尾部新增列表项' : editor.action === 'list-edit' ? `修改索引 ${editor.index}` : memberEditor ? editor.action === 'zset-edit' ? '修改分数' : '新增成员' : editor.action === 'create' ? '新增键' : editor.action === 'hash-create' ? '新增字段' : editor.action === 'hash-edit' ? '修改字段' : '修改值';
    const target = memberEditor ? `${editor.key.slice(0,80)} · 成员 ${editor.member?.slice(0,80) || '(空成员)'}` : editor.action.startsWith('hash-') ? `${editor.key.slice(0,80)} · 字段 ${editor.field?.slice(0,80) || '(空字段)'}` : editor.key.slice(0,80);
    if (!window.confirm(`确认${operation}：${target}？`)) return;
    const draft = editor; const controller = new AbortController(); mutation.current = controller; setMutating(true); setError('');
    try {
      await mutate({ action: draft.action, key: draft.key, keyEncoding: draft.keyEncoding, field: draft.field, fieldEncoding: draft.fieldEncoding, member: draft.member, memberEncoding: draft.memberEncoding, score: draft.score, expectedScore: draft.originalScore, index: draft.index, expectedLength: draft.expectedLength, side: draft.side, value: draft.value, valueEncoding: draft.valueEncoding, expectedVersion: draft.version, confirm: true }, controller.signal);
      if (!controller.signal.aborted && live.current) { setEditor(undefined); if (/^(?:hash|set|zset|list)-/.test(draft.action)) await inspect({ key: draft.key, keyEncoding: draft.keyEncoding, bytes: 0 }); else await load(true); }
    } catch (reason: any) { if (!controller.signal.aborted && live.current) setError(reason?.response?.data?.message || reason.message || '保存失败'); }
    finally { if (!controller.signal.aborted && live.current) setMutating(false); }
  }
  function openHashEditor(row?: any) {
    if (!selected) return;
    setEditor({ action: row ? 'hash-edit' : 'hash-create', key: selected.key, keyEncoding: selected.keyEncoding, field: row?.reference?.value || '', fieldEncoding: row?.reference?.encoding || 'utf8', value: row?.value?.value || '', valueEncoding: row?.value?.encoding || 'utf8', baseline: row?.value?.value, baselineEncoding: row?.value?.encoding, version: row?.version });
  }
  function openListEditor(row?: any) {
    if (!selected) return;
    setEditor({ action: row ? 'list-edit' : 'list-push', key: selected.key, keyEncoding: selected.keyEncoding, index: row?.index, expectedLength: detail.size, side: 'right', value: row?.value?.value || '', valueEncoding: row?.value?.encoding || 'utf8', baseline: row?.value?.value, baselineEncoding: row?.value?.encoding, version: row?.version });
  }
  async function deleteListItem(row: any) {
    if (!selected || !mutate || !window.confirm(`确认删除列表索引 ${row.index}？后续索引将改变。`)) return;
    const item = selected; const controller = new AbortController(); mutation.current = controller; setMutating(true); setError('');
    try {
      await mutate({ action: 'list-delete', key: item.key, keyEncoding: item.keyEncoding, index: row.index, expectedLength: detail.size, expectedVersion: row.version, confirm: true }, controller.signal);
      if (!controller.signal.aborted && live.current) await inspect(item);
    } catch (reason: any) { if (!controller.signal.aborted && live.current) setError(reason?.response?.data?.message || reason.message || '删除列表项失败'); }
    finally { if (!controller.signal.aborted && live.current) setMutating(false); }
  }
  function openMemberEditor(row?: any) {
    if (!selected || !['set', 'zset'].includes(detail?.type)) return;
    setEditor({ action: row ? 'zset-edit' : detail.type === 'set' ? 'set-create' : 'zset-create', key: selected.key, keyEncoding: selected.keyEncoding, member: row?.reference?.value || '', memberEncoding: row?.reference?.encoding || 'utf8', score: row?.score || '0', originalScore: row?.score, value: '', valueEncoding: 'utf8' });
  }
  async function deleteMember(row: any) {
    if (!selected || !mutate || !row.reference || !window.confirm(`确认删除成员：${row.name.value.slice(0,80)}？`)) return;
    const item = selected; const controller = new AbortController(); mutation.current = controller; setMutating(true); setError('');
    try {
      await mutate({ action: detail.type === 'set' ? 'set-delete' : 'zset-delete', key: item.key, keyEncoding: item.keyEncoding, member: row.reference.value, memberEncoding: row.reference.encoding, expectedScore: row.score, confirm: true }, controller.signal);
      if (!controller.signal.aborted && live.current) await inspect(item);
    } catch (reason: any) { if (!controller.signal.aborted && live.current) setError(reason?.response?.data?.message || reason.message || '删除成员失败'); }
    finally { if (!controller.signal.aborted && live.current) setMutating(false); }
  }
  function memberActions(row: any) {
    return mutate && detail.canWriteRedis === true && ['set', 'zset'].includes(detail.type) && row.reference && !row.nameTruncated ? <div className="mt-2 flex gap-2">
      {detail.type === 'zset' && Number.isFinite(Number(row.score)) && <button className="text-indigo-500" disabled={!!editor} onClick={() => openMemberEditor(row)}>编辑分数</button>}
      {(detail.type === 'set' || Number.isFinite(Number(row.score))) && <button className="text-red-500" disabled={!!editor} onClick={() => void deleteMember(row)}>删除成员</button>}
    </div> : null;
  }
  async function deleteField(row: any) {
    if (!selected || !mutate || !window.confirm(`确认删除字段：${row.name.value.slice(0,80)}？`)) return;
    const item = selected; const controller = new AbortController(); mutation.current = controller; setMutating(true); setError('');
    try {
      await mutate({ action: 'hash-delete', key: item.key, keyEncoding: item.keyEncoding, field: row.reference.value, fieldEncoding: row.reference.encoding, expectedVersion: row.version, confirm: true }, controller.signal);
      if (!controller.signal.aborted && live.current) await inspect(item);
    } catch (reason: any) { if (!controller.signal.aborted && live.current) setError(reason?.response?.data?.message || reason.message || '删除字段失败'); }
    finally { if (!controller.signal.aborted && live.current) setMutating(false); }
  }
  useEffect(() => {
    live.current = true; void load(true);
    return () => { live.current = false; scan.current?.abort(); preview.current?.abort(); mutation.current?.abort(); };
  }, [request]);
  return <fieldset disabled={mutating} className="card mb-4 min-w-0 overflow-hidden p-0" data-redis-browser>
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 dark:border-slate-800">
      <h3 className="mr-auto text-sm font-semibold">Redis 键浏览</h3>
      {mutate && canWrite && <button className="btn btn-secondary btn-sm" onClick={() => setEditor({ action: 'create', key: '', keyEncoding: 'utf8', value: '', valueEncoding: 'utf8' })} disabled={!!editor}>新增键</button>}
      <form className="flex items-center gap-2" onSubmit={event => { event.preventDefault(); void load(true); }}>
        <input aria-label="Redis 键匹配" className="input w-48 font-mono text-xs" value={pattern} onChange={event => setPattern(event.target.value)} placeholder="* 或 user:*" />
        <button className="btn btn-secondary btn-sm" disabled={busy} aria-label="搜索 Redis 键"><Search size={14} /></button>
      </form>
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void load(true)} aria-label="刷新 Redis 键"><RefreshCw size={14} /></button>
    </div>
    {error && <p role="alert" className="px-4 py-2 text-xs text-red-500">{error}</p>}
    {notice && <p className="px-4 py-2 text-xs text-amber-600">{notice}</p>}
    {editor && <form className="space-y-3 border-b p-4 dark:border-slate-800" data-redis-value-editor onSubmit={event => { event.preventDefault(); void saveValue(); }}>
      <div className="flex gap-2"><input aria-label="Redis 新键名称" className="input min-w-0 flex-1 text-xs" value={editor.key} disabled={editor.action !== 'create'} onChange={event => setEditor({ ...editor, key: event.target.value })} placeholder="键名称" />
        <Select value={editor.keyEncoding} disabled={editor.action !== 'create'} onChange={value => setEditor({ ...editor, keyEncoding: value as 'utf8' | 'base64' })} options={[{ value: 'utf8', label: 'UTF-8 键' }, { value: 'base64', label: 'Base64 键' }]} /></div>
      {editor.action.startsWith('hash-') && <div className="flex gap-2"><input aria-label="Redis 哈希字段" className="input min-w-0 flex-1 text-xs" value={editor.field} disabled={editor.action === 'hash-edit'} onChange={event => setEditor({ ...editor, field: event.target.value })} placeholder="字段名" /><Select value={editor.fieldEncoding || 'utf8'} disabled={editor.action === 'hash-edit'} onChange={value => setEditor({ ...editor, fieldEncoding: value as 'utf8' | 'base64' })} options={[{ value: 'utf8', label: 'UTF-8 字段' }, { value: 'base64', label: 'Base64 字段' }]} /></div>}
      {editor.action === 'list-push' && <Select value={editor.side || 'right'} onChange={value => setEditor({ ...editor, side: value as 'left' | 'right' })} options={[{ value: 'right', label: '从尾部新增' }, { value: 'left', label: '从头部新增' }]} />}
      {editor.action === 'list-edit' && <p className="text-xs text-muted">正在编辑索引 {editor.index} · 读取时列表长度 {editor.expectedLength}</p>}
      {memberEditor ? <>
        <Select value={editor.memberEncoding || 'utf8'} disabled={editor.action === 'zset-edit'} onChange={value => setEditor({ ...editor, memberEncoding: value as 'utf8' | 'base64' })} options={[{ value: 'utf8', label: 'UTF-8 成员' }, { value: 'base64', label: 'Base64 成员' }]} />
        <textarea aria-label="Redis 成员内容" className="input h-28 w-full font-mono text-xs" value={editor.member || ''} disabled={editor.action === 'zset-edit'} onChange={event => setEditor({ ...editor, member: event.target.value })} />
        {editor.action.startsWith('zset-') && <input aria-label="Redis 成员分数" className="input w-full text-xs" value={editor.score || ''} onChange={event => setEditor({ ...editor, score: event.target.value })} placeholder="有限数字，例如 1.5" />}
      </> : <>
        <Select value={editor.valueEncoding} onChange={value => setEditor({ ...editor, valueEncoding: value as 'utf8' | 'base64' })} options={[{ value: 'utf8', label: 'UTF-8 值' }, { value: 'base64', label: 'Base64 值' }]} />
        <textarea aria-label="Redis 值内容" className="input h-28 w-full font-mono text-xs" value={editor.value} onChange={event => setEditor({ ...editor, value: event.target.value })} />
      </>}
      <p className="text-xs text-muted">{memberEditor ? '成员最多 8 KiB；新增不会覆盖已有成员，分数修改会检查原始分数。' : '最多 16 KiB；新增不会覆盖已有键。'} 编辑保留 TTL 并检查并发修改。</p>
      <div className="flex gap-2"><button className="btn btn-primary btn-sm" type="submit" disabled={mutating || (editor.action === 'create' && !editor.key)}>保存值</button><button className="btn btn-secondary btn-sm" type="button" onClick={() => { if (window.confirm('放弃当前未保存内容？')) setEditor(undefined); }}>取消编辑</button></div>
    </form>}
    <div className="grid min-h-56 grid-cols-[minmax(140px,1fr)_minmax(0,2fr)]">
      <div className="flex max-h-80 flex-col border-r dark:border-slate-800">
        <div className="min-h-0 flex-1 overflow-auto p-2">{items.map(item => <button key={identity(item)} className={`mb-1 block w-full truncate rounded-lg px-2 py-1.5 text-left font-mono text-xs ${selected && identity(selected) === identity(item) ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`} title={item.key} onClick={() => void inspect(item)} data-redis-key>{item.keyEncoding === 'base64' ? '[Base64] ' : ''}{item.key || '(空键)'}</button>)}{!items.length && <p className="p-3 text-xs text-muted">{busy ? '正在扫描…' : '本轮未返回键'}</p>}</div>
        <div className="border-t p-2 text-xs dark:border-slate-800"><p className="mb-2 text-muted">本页 {items.length} 个键 · {started && cursor === '0' ? '扫描已结束' : '可继续扫描'}</p><button className="btn btn-secondary btn-sm w-full" disabled={busy || (started && cursor === '0')} onClick={() => void load(!started)}>{busy ? '正在读取…' : '继续扫描'}</button></div>
      </div>
      <div className="min-w-0 p-4 text-xs">{detailBusy ? <p className="text-muted">正在读取键信息…</p> : !selected ? <p className="text-muted">选择键查看类型、TTL 和内容</p> : detail && <>
        {mutate && detail.exists && detail.canWriteRedis === true && <div className="mb-3 flex flex-wrap items-center gap-2" data-redis-mutations>
          {detail.type === 'hash' && <button className="btn btn-secondary btn-sm" disabled={!!editor} onClick={() => openHashEditor()}>新增字段</button>}
          {detail.type === 'list' && <button className="btn btn-secondary btn-sm" disabled={!!editor} onClick={() => openListEditor()}>新增列表项</button>}
          {['set', 'zset'].includes(detail.type) && <button className="btn btn-secondary btn-sm" disabled={!!editor} onClick={() => openMemberEditor()}>新增成员</button>}
          {detail.type === 'string' && detail.version && !detail.truncated && <button className="btn btn-secondary btn-sm" disabled={!!editor} onClick={() => setEditor({ action: 'edit', key: selected.key, keyEncoding: selected.keyEncoding, value: detail.value, valueEncoding: detail.encoding, version: detail.version, baseline: detail.value, baselineEncoding: detail.encoding })}>编辑值</button>}
          <input aria-label="Redis TTL 秒数" className="input w-24 text-xs" value={seconds} onChange={event => setSeconds(event.target.value)} disabled={mutating} />
          <button className="btn btn-secondary btn-sm" disabled={mutating} onClick={() => void modify('expire')}>设置 TTL</button>
          <button className="btn btn-secondary btn-sm" disabled={mutating} onClick={() => void modify('persist')}>永久保存</button>
          <button className="btn btn-secondary btn-sm text-red-500" disabled={mutating} onClick={() => void modify('delete')}>删除键</button>
        </div>}
        <div className="mb-3 flex flex-wrap gap-3"><span>类型：{detail.type}</span><span>TTL：{detail.ttlMs === -1 ? '永久' : detail.ttlMs === -2 ? '键已不存在' : `${detail.ttlMs} ms`}</span>{detail.size !== undefined && <span>大小：{detail.size} {detail.type === 'string' ? '字节' : '项'}</span>}</div>
        {detail.exists === false ? <p className="text-muted">键已过期或删除，请刷新列表。</p> : detail.supported === false ? <p className="text-muted">{detail.message}</p> : detail.pageKind === 'collection' ? <>
          {detail.partial && <p className="mb-2 text-amber-600">部分字段或成员较大，仅展示长度或前 1 KiB，不代表完整值。</p>}
          <div className="max-h-48 overflow-auto"><table className="w-full table-fixed text-left text-xs"><thead><tr className="border-b dark:border-slate-800"><th className="w-1/3 py-2">{detail.type === 'list' ? '索引' : detail.type === 'hash' ? '字段' : '成员'}</th><th className="py-2">{detail.type === 'zset' ? '分数' : detail.type === 'set' ? '大小' : '值'}</th></tr></thead><tbody>
            {detail.items.map((row: any, index: number) => <tr key={index} data-redis-collection-row className="border-b align-top dark:border-slate-800">
              <td className="break-all py-2 pr-3 font-mono">{row.index ?? <>{row.name?.encoding === 'base64' ? '[Base64] ' : ''}{row.name?.value || '(空成员)'}{row.nameTruncated && <span className="block text-muted">{row.nameBytes} 字节 · 已截断</span>}</>}</td>
              <td className="break-all py-2 font-mono">{detail.type === 'zset' ? row.score : detail.type === 'set' ? `${row.nameBytes} 字节` : <>{row.value?.encoding === 'base64' ? '[Base64] ' : ''}{row.value ? row.value.value || '(空字符串)' : '大字段未下载'}<span className="mt-1 block text-muted">{row.valueBytes} 字节{row.truncated ? ' · 部分预览' : ''}</span></>}
                {mutate && detail.canWriteRedis === true && detail.type === 'hash' && row.reference && row.version && !row.truncated && !row.nameTruncated && <div className="mt-2 flex gap-2"><button className="text-indigo-500" disabled={!!editor} onClick={() => openHashEditor(row)}>编辑字段</button><button className="text-red-500" disabled={!!editor} onClick={() => void deleteField(row)}>删除字段</button></div>}
                {memberActions(row)}
                {mutate && detail.canWriteRedis === true && detail.type === 'list' && row.version && !row.truncated && <div className="mt-2 flex gap-2"><button className="text-indigo-500" disabled={!!editor} onClick={() => openListEditor(row)}>编辑列表项</button><button className="text-red-500" disabled={!!editor || Math.min(row.index, detail.size - row.index - 1) > 1000} title="删除从较近的端点移动至该位置，最多移动 1000 项" onClick={() => void deleteListItem(row)}>删除列表项</button></div>}
              </td>
            </tr>)}
          </tbody></table>{!detail.items.length && <p className="py-3 text-muted">本轮未返回成员，可继续翻页。</p>}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {['list', 'zset'].includes(detail.type) && <button className="btn btn-secondary btn-sm" disabled={!detail.offset} onClick={() => void inspect(selected, Math.max(0, detail.offset - detail.count))}>上一页</button>}
            <button className="btn btn-secondary btn-sm" disabled={!detail.hasMore} onClick={() => void inspect(selected, ['hash', 'set'].includes(detail.type) ? 0 : detail.nextOffset, { cursor: detail.cursor, scanOffset: detail.nextScanOffset })}>下一页</button>
            <button className="btn btn-secondary btn-sm" onClick={() => void inspect(selected, detail.offset || 0, { cursor: detail.pageCursor || '0', scanOffset: detail.scanOffset || 0 })}>刷新当前页</button>
            <button className="btn btn-secondary btn-sm" onClick={() => void inspect(selected)}>从头读取</button>
          </div>
        </> : <>
          <p className="mb-2 text-muted">字节偏移 {detail.offset} · 本次 {detail.bytes} 字节{detail.encoding === 'base64' ? ' · 此字节范围以 Base64 无损展示' : ''}{detail.truncated ? ' · 分段预览' : ''}</p>
          <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-3 font-mono text-slate-100" data-redis-value>{detail.value}</pre>
          <div className="mt-3 flex gap-2"><button className="btn btn-secondary btn-sm" disabled={!detail.offset} onClick={() => void inspect(selected, Math.max(0, detail.offset - 16384))}>上一段</button><button className="btn btn-secondary btn-sm" disabled={!detail.hasMore} onClick={() => void inspect(selected, detail.nextOffset)}>下一段</button><button className="btn btn-secondary btn-sm" onClick={() => void inspect(selected, detail.offset || 0)}>刷新值</button></div>
        </>}
      </>}</div>
    </div>
  </fieldset>;
}
