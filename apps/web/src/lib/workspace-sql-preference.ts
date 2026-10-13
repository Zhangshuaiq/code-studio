const writes = new Map<string, Promise<void>>();
export interface SqlBindingPreference { connectionId: string; database: string; table: string }
export function validateSqlPreference(input: unknown): SqlBindingPreference | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  for (const [key, limit] of [['connectionId', 128], ['database', 128], ['table', 512]] as const) if (typeof value[key] !== 'string' || (value[key] as string).length > limit || (value[key] as string).includes('\0')) return;
  if (value.connectionId && !/^[a-zA-Z0-9_-]+$/.test(value.connectionId as string)) return;
  return { connectionId: value.connectionId as string, database: value.database as string, table: value.table as string };
}
export async function loadSqlPreference(local: boolean, key: string, projectId: string, signal: AbortSignal) {
  if (local) { const response = await fetch(`/api/local/projects/${encodeURIComponent(projectId)}/sql-binding`, { signal }); const body = await response.json(); if (!response.ok) throw new Error(body.message); return validateSqlPreference(body.preference); }
  try { return validateSqlPreference(JSON.parse(localStorage.getItem(`code-studio:sql-binding:${key}`) || 'null')); } catch { return; }
}
export async function saveSqlPreference(local: boolean, key: string, projectId: string, preference: SqlBindingPreference) {
  const value = validateSqlPreference(preference); if (!value) throw new Error('SQL 绑定设置无效');
  const storageKey = local ? `local:${projectId}` : `remote:${key}`;
  const pending = (writes.get(storageKey) || Promise.resolve()).catch(() => {}).then(async () => {
    if (local) {
      const response = await fetch(`/api/local/projects/${encodeURIComponent(projectId)}/sql-binding`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.message || 'SQL 绑定保存失败'); }
    } else localStorage.setItem(`code-studio:sql-binding:${key}`, JSON.stringify(value));
  });
  writes.set(storageKey, pending);
  try { await pending; } finally { if (writes.get(storageKey) === pending) writes.delete(storageKey); }
}
