import { useEffect, useRef, useState } from 'react';
import { Select } from '../common/Select';
import { clearWorkspaceSqlContext, publishWorkspaceSqlContext } from '../../lib/workspace-sql-context';
import { sqlConnections, sqlMetadata, sqlTables, type SqlConnection, type SqlTable } from '../../lib/workspace-sql-transport';
import { loadSqlPreference, saveSqlPreference, type SqlBindingPreference } from '../../lib/workspace-sql-preference';
export function WorkspaceSqlBinding({ scope, local, preferenceKey = scope, projectId = '', content = '', active = true }: { scope: string; local: boolean; preferenceKey?: string; projectId?: string; content?: string; active?: boolean }) {
  const [references, setReferences] = useState<string[]>([]);
  const referenceKey = JSON.stringify(references);
  const saved = useRef<SqlBindingPreference>();
  const [ready, setReady] = useState(false);
  const activeRef = useRef(active); activeRef.current = active;
  const [connections, setConnections] = useState<SqlConnection[]>([]); const [connectionId, setConnectionId] = useState('');
  const [databases, setDatabases] = useState<string[]>([]); const [database, setDatabase] = useState('');
  const [tables, setTables] = useState<SqlTable[]>([]); const [table, setTable] = useState(''); const [status, setStatus] = useState(''); const [tick, setTick] = useState(0);
  const connection = connections.find(item => item.id === connectionId);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!active || !connection) { setReferences([]); return; }
      void import('../../lib/sql-intelligence').then(module => { if (!cancelled) { const next = module.sqlReferencedTables(content, connection.dialect); setReferences(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); } }).catch(error => { if (!cancelled) setStatus(error.message); });
    }, 600);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [content, active, connection?.id, connection?.dialect]);
  useEffect(() => {
    const controller = new AbortController(); setReady(false); saved.current = undefined;
    void loadSqlPreference(local, preferenceKey, projectId, controller.signal).then(value => { if (!controller.signal.aborted) saved.current = value; }).catch(error => { if (!controller.signal.aborted) setStatus(error.message); }).finally(() => { if (!controller.signal.aborted) setReady(true); });
    return () => controller.abort();
  }, [local, preferenceKey, projectId]);
  const persist = (value: SqlBindingPreference) => { saved.current = undefined; void saveSqlPreference(local, preferenceKey, projectId, value).catch(error => setStatus(error.message)); };
  useEffect(() => { if (!active) { clearWorkspaceSqlContext(scope); return; } setTick(value => value + 1); const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') setTick(value => value + 1); }, 20000); return () => { window.clearInterval(timer); clearWorkspaceSqlContext(scope); }; }, [scope, active]);
  useEffect(() => {
    if (!activeRef.current || !ready) return;
    const controller = new AbortController();
    void sqlConnections(local, controller.signal).then(items => { if (!controller.signal.aborted) { setConnections(items); if (saved.current?.connectionId) { const id = saved.current.connectionId; if (items.some(item => item.id === id)) setConnectionId(id); else saved.current = undefined; } if (connectionId && !items.some(item => item.id === connectionId)) { clearWorkspaceSqlContext(scope); setConnectionId(''); } } }).catch(error => { if (!controller.signal.aborted) { clearWorkspaceSqlContext(scope); setStatus(error.response?.data?.message || error.message); } });
    return () => controller.abort();
  }, [scope, local, tick, ready]);
  useEffect(() => {
    clearWorkspaceSqlContext(scope); setDatabases([]); setDatabase(''); setTables([]); setTable('');
    if (!connection) return;
    const controller = new AbortController(); setStatus('正在读取数据库…');
    void sqlMetadata(local, connection, 'databases', {}, controller.signal).then(body => { if (!controller.signal.aborted) { const names = body.items.map((item: any) => local ? item.name : item); setDatabases(names); if (saved.current?.connectionId === connection.id && names.includes(saved.current.database)) setDatabase(saved.current.database); else saved.current = undefined; setStatus(body.truncated ? '数据库列表部分加载' : '请选择数据库'); } }).catch(error => { if (!controller.signal.aborted) setStatus(error.response?.data?.message || error.message); });
    return () => controller.abort();
  }, [scope, local, connectionId, connection?.updatedAt]);
  useEffect(() => {
    clearWorkspaceSqlContext(scope);
    if (!activeRef.current || !connection || !database) return;
    const controller = new AbortController(); setStatus('正在读取表结构…');
    void (async () => {
      const body = await sqlMetadata(local, connection, 'tables', { database }, controller.signal);
      const next = sqlTables(local, connection, body.items, database); if (controller.signal.aborted) return;
      setTables(next);
      if (saved.current?.connectionId === connection.id && saved.current.database === database) {
        const restoredTable = saved.current.table; saved.current = undefined;
        if (restoredTable && next.some(item => item.label === restoredTable)) { setTable(restoredTable); return; }
      }
      const target = next.find(item => item.label === table); let partial = body.truncated || content.length > 1_000_000 || references.length > 128;
      const module = await import('../../lib/sql-intelligence');
      const referenced = next.filter(item => references.slice(0, 128).some(reference => {
        const parts = module.sqlIdentifierParts(reference, connection.dialect === 'postgresql');
        return parts.length === 1 ? parts[0] === item.name && (connection.dialect !== 'postgresql' || item.schema === 'public') : parts.length === 2 && parts[0] === item.schema && parts[1] === item.name;
      }));
      const targets = [...new Map([...(target ? [target] : []), ...referenced].map(item => [item.label, item])).values()];
      partial ||= targets.length > 8;
      const structures: Record<string, any[]> = Object.create(null);
      for (let offset = 0; offset < Math.min(targets.length, 8); offset += 3) {
        if (controller.signal.aborted || !activeRef.current) return;
        await Promise.all(targets.slice(offset, Math.min(offset + 3, 8)).map(async item => {
          const detail = await sqlMetadata(local, connection, 'columns', { database, schema: item.schema, table: item.name }, controller.signal);
          partial ||= detail.truncated;
          structures[item.label] = detail.items.map((column: any) => ({ column_name: column.name || column.column_name || column.Field, data_type: column.type || column.data_type || column.Type }));
        }));
      }
      if (controller.signal.aborted || !activeRef.current) return;
      publishWorkspaceSqlContext(scope, JSON.stringify([connection.id, connection.updatedAt, database, table]), { dialect: connection.dialect, defaultSchema: connection.dialect === 'postgresql' ? 'public' : undefined, tables: next.map(item => item.label), tableStructures: structures });
      setStatus(content.length > 1_000_000 ? '文件过大 · 可手动选择提示表' : targets.length > 8 ? '已加载前 8 张表 · 提示表可优先加载' : partial ? '部分结构已加载' : targets.length ? '表/列提示就绪' : '表名提示就绪 · 自动读取引用表的列');
    })().catch(error => { if (!controller.signal.aborted) { clearWorkspaceSqlContext(scope); setStatus(error.response?.data?.message || error.message); controller.abort(); } });
    return () => controller.abort();
  }, [scope, local, connectionId, connection?.updatedAt, database, table, tick, referenceKey]);
  return <div data-workspace-sql-binding className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs dark:border-slate-800">
    <span className="text-muted">SQL 提示</span>
    <Select value={connectionId} onChange={value => { clearWorkspaceSqlContext(scope); persist({ connectionId: value, database: '', table: '' }); setConnectionId(value); }} options={[{ value: '', label: '未绑定连接' }, ...connections.map(item => ({ value: item.id, label: item.name }))]} />
    <Select value={database} onChange={value => { clearWorkspaceSqlContext(scope); persist({ connectionId, database: value, table: '' }); setTables([]); setTable(''); setDatabase(value); }} disabled={!connection} options={[{ value: '', label: '选择数据库' }, ...databases.map(name => ({ value: name, label: name }))]} />
    <Select value={table} onChange={value => { clearWorkspaceSqlContext(scope); persist({ connectionId, database, table: value }); setTable(value); }} disabled={!database} options={[{ value: '', label: '提示表（可选）' }, ...tables.map(item => ({ value: item.label, label: item.label }))]} />
    <span role="status" className="max-w-72 truncate text-[10px] text-muted" title={status}>{connectionId ? status : '使用已打开的 DDL 提示'}</span>
  </div>;
}
