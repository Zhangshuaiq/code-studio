import type { SqlMetadata } from './sql-intelligence';
export interface WorkspaceSqlContext { revision: number; expiresAt: number; metadata: SqlMetadata; binding: string }
const contexts = new Map<string, WorkspaceSqlContext>(); let sequence = 0;
export function workspaceSqlScope(mode: 'local' | 'remote', workspaceId: string, userId?: string) {
  if (!workspaceId || (mode === 'remote' && !userId)) throw new Error('SQL 提示缺少工作区或用户范围');
  return JSON.stringify([mode, workspaceId, mode === 'remote' ? userId : 'local']);
}
export function publishWorkspaceSqlContext(scope: string, binding: string, metadata: SqlMetadata, now = Date.now()) {
  if (!scope || !binding || (metadata.tables?.length || 0) > 500 || Object.keys(metadata.tableStructures || {}).length > 500) throw new Error('SQL 元数据范围无效或超过表数量上限');
  const raw = JSON.stringify(metadata);
  if (new TextEncoder().encode(raw).length > 1_000_000 || Object.values(metadata.tableStructures || {}).reduce((n, columns) => n + columns.length, 0) > 10000) throw new Error('SQL 元数据超过资源上限');
  // No credential, connection config or executable request callback is retained.
  const copy: SqlMetadata = { dialect: metadata.dialect, defaultSchema: metadata.defaultSchema, tables: [...(metadata.tables || [])], tableStructures: Object.fromEntries(Object.entries(metadata.tableStructures || {}).map(([table, columns]) => [table, columns.map(column => ({ column_name: column.column_name, Field: column.Field, data_type: column.data_type, Type: column.Type }))])) };
  Object.values(copy.tableStructures!).forEach(columns => { columns.forEach(Object.freeze); Object.freeze(columns); }); Object.freeze(copy.tableStructures); Object.freeze(copy.tables); Object.freeze(copy);
  const snapshot = Object.freeze({ revision: ++sequence, expiresAt: now + 30000, metadata: copy, binding });
  contexts.set(scope, snapshot); return snapshot;
}
export function readWorkspaceSqlContext(scope: string, now = Date.now()): WorkspaceSqlContext | undefined {
  const context = contexts.get(scope); return context && context.expiresAt > now ? context : undefined;
}
export function clearWorkspaceSqlContext(scope: string) { contexts.delete(scope); sequence++; }
