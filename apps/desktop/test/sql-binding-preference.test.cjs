const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalApi } = require('../src/local-api.cjs');
const { sqlBindingPreference } = require('@codegen/code-intelligence/sql-binding-preference.cjs');

test('SQL preferences contain references only and reject invalid identifiers', () => {
  assert.deepEqual(sqlBindingPreference({ connectionId: 'abc-123', database: 'db', table: 'public.users', password: 'secret', columns: ['private'] }), { connectionId: 'abc-123', database: 'db', table: 'public.users' });
  for (const input of [null, {}, { connectionId: '../escape', database: '', table: '' }, { connectionId: '', database: '\0', table: '' }]) assert.throws(() => sqlBindingPreference(input));
});

test('SQL binding survives Local API restart without persisting secrets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-binding-'));
  let api;
  t.after(async () => { await api?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const options = { token: 'sql-binding-test', storePath: path.join(directory, 'store.sqlite3') };
  const headers = { Authorization: 'Bearer sql-binding-test', 'Content-Type': 'application/json' };
  api = await createLocalApi(options);
  const project = api.registerWorkspace(directory);
  const connector = await (await fetch(api.origin + '/api/local/connectors', { method: 'POST', headers, body: JSON.stringify({ name: 'Test DB', type: 'postgres', settings: { host: 'localhost' } }) })).json();
  const route = `/api/local/projects/${project.id}/sql-binding`;
  const preference = { connectionId: connector.id, database: 'test_db', table: 'public.users' };
  assert.equal((await fetch(api.origin + route)).status, 401);
  assert.equal((await fetch(api.origin + route, { method: 'PUT', headers, body: JSON.stringify({ ...preference, password: 'must-not-persist' }) })).status, 200);
  await api.close(); api = await createLocalApi(options);
  const result = await fetch(api.origin + route, { headers });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { preference });
  assert.equal((await fetch(api.origin + route, { method: 'PUT', headers, body: JSON.stringify({ ...preference, connectionId: 'missing' }) })).status, 400);
});
