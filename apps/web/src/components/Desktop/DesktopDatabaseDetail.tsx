import { lazy, Suspense, useMemo, useState } from 'react';
import type { DbQueryTransport } from '../../hooks/useDbQuery';
import type { Datasource } from '../../hooks/useDatasources';
const DbQueryPage = lazy(() => import('../DbQuery/DbQueryPage').then((module) => ({ default: module.DbQueryPage })));

export function DesktopDatabaseDetail({ connector, onBack, onEdit }: { connector: { id: string; name: string; type: 'postgres' | 'mysql'; settings: Record<string, any>; updatedAt?: string }; onBack: () => void; onEdit: () => void }) {
  const [notice, setNotice] = useState('');
  const transport = useMemo<DbQueryTransport>(() => {
    const tablesByDatabase = new Map<string, Map<string, { schema: string; name: string }>>();
    const quote = (name: string) => { const q = connector.type === 'mysql' ? '`' : '"'; return q + name.split(q).join(q + q) + q; };
    const metadata = async (input: Record<string, unknown>, signal?: AbortSignal) => {
      const response = await fetch(`/api/local/connectors/${connector.id}/metadata`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
      const body = await response.json(); if (!response.ok) throw new Error(body.message || '无法读取数据库结构');
      if (body.truncated) setNotice('结构列表较大，目前仅显示前 500 项。');
      return body.items;
    };
    return {
      scope: `${connector.id}:${connector.updatedAt || JSON.stringify(connector.settings)}`,
      async databases(_id, signal) { return (await metadata({ action: 'databases' }, signal)).map((item: any) => item.name); },
      async tables(_id, database, signal) {
        const rows = await metadata({ action: 'tables', database }, signal);
        const names = new Map<string, { schema: string; name: string }>();
        for (const row of rows) names.set(connector.type === 'postgres' ? `${quote(row.schema)}.${quote(row.name)}` : row.name, row);
        tablesByDatabase.set(database || '', names);
        return [...names.keys()];
      },
      async describe(_id, table, database, signal) {
        let target = tablesByDatabase.get(database || '')?.get(table);
        if (!target) {
          const rows = await metadata({ action: 'tables', database }, signal);
          target = rows.find((row: any) => (connector.type === 'postgres' ? `${quote(row.schema)}.${quote(row.name)}` : row.name) === table);
        }
        if (!target) throw new Error('表引用已失效，请重新选择数据表');
        return (await metadata({ action: 'columns', database, schema: target.schema, table: target.name }, signal)).map((column: any) => ({ column_name: column.name, data_type: column.type, is_nullable: column.nullable, column_default: column.default }));
      },
      selectSql(table) { return `SELECT * FROM ${connector.type === 'postgres' ? table : quote(table)} LIMIT 10;`; },
      async execute(_id, payload) {
        const response = await fetch(`/api/local/connectors/${connector.id}/explore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const body = await response.json(); if (!response.ok) throw new Error(body.message || '执行失败');
        if (body.truncated) setNotice('查询结果较大，目前仅显示前 500 行。');
        return body.kind === 'table' ? body.rows : body;
      },
    };
  }, [connector.id, connector.type, connector.updatedAt, connector.settings]);
  const datasource: Datasource = { id: connector.id, name: connector.name, type: connector.type === 'postgres' ? 'postgresql' : 'mysql', category: 'relational', teamId: '', config: connector.settings as Datasource['config'], createdAt: '', updatedAt: connector.updatedAt || '' };
  return <Suspense fallback={<div className="grid h-full place-items-center text-xs text-slate-400">正在打开连接详情…</div>}><DbQueryPage local={{ datasource, transport, onBack, onEdit, notice }} /></Suspense>;
}
