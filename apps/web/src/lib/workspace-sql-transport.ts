import { api } from './api';
export interface SqlConnection { id: string; name: string; dialect: 'mysql' | 'postgresql'; updatedAt?: string }
export interface SqlTable { name: string; schema: string; label: string }
const quote = (value: string, dialect: string) => { const char = dialect === 'mysql' ? '`' : '"'; return char + value.split(char).join(char + char) + char; };
export async function sqlConnections(local: boolean, signal: AbortSignal): Promise<SqlConnection[]> {
  const body = local ? await localJson('/api/local/connectors', undefined, signal) : (await api.get('/admin/datasources', { params: { category: 'relational', pageSize: 500 }, signal })).data;
  return (body.items || []).filter((row: any) => ['postgres', 'postgresql', 'mysql'].includes(row.type)).map((row: any) => ({ id: row.id, name: row.name, dialect: row.type === 'mysql' ? 'mysql' : 'postgresql', updatedAt: row.updatedAt }));
}
async function localJson(path: string, input: unknown, signal: AbortSignal) {
  const response = await fetch(path, { ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}), signal });
  const body = await response.json(); if (!response.ok) throw Object.assign(new Error(body.message || '无法读取 SQL 元数据'), { status: response.status }); return body;
}
export async function sqlMetadata(local: boolean, connection: SqlConnection, action: 'databases' | 'tables' | 'columns', input: { database?: string; table?: string; schema?: string }, signal: AbortSignal) {
  const params = { action, ...input };
  return local ? localJson(`/api/local/connectors/${encodeURIComponent(connection.id)}/metadata`, params, signal) : (await api.get(`/db-query/${encodeURIComponent(connection.id)}/metadata`, { params: { action, database: input.database, table: input.table }, signal })).data;
}
export function sqlTables(local: boolean, connection: SqlConnection, rows: any[], database: string): SqlTable[] {
  return rows.map(row => {
    const name = local ? row.name : row; const schema = local ? row.schema : connection.dialect === 'postgresql' ? 'public' : database;
    return { name, schema, label: connection.dialect === 'postgresql' ? `${quote(schema, connection.dialect)}.${quote(name, connection.dialect)}` : quote(name, connection.dialect) };
  });
}
