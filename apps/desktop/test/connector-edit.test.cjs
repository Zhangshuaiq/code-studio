const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalApi } = require('../src/local-api.cjs');
const { validateConnector } = require('../src/local-connector-runtime.cjs');

test('database hosts reject embedded ports and URLs but support IPv6', () => {
  const config = { name: 'DB', type: 'postgres', settings: { host: '10.62.172.112:5432', port: 5432 } };
  assert.throws(() => validateConnector(config, 'test'), /主机地址不要包含端口/);
  assert.throws(() => validateConnector({ ...config, settings: { host: 'postgres://localhost:5432' } }, 'test'), /连接 URL/);
  for (const host of ['10.62.172.112', 'localhost', '::1', '[2001:db8::1]']) {
    assert.equal(validateConnector({ ...config, settings: { host } }, 'test').settings.host, host.replace(/^\[|\]$/g, ''));
  }
});

test('connector updates retain identity and credentials, validate hosts and persist across restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-edit-'));
  const options = { token: 'connector-test', storePath: path.join(directory, 'store.sqlite3'), credentialCodec: { available: () => true, encrypt: value => Buffer.from(`encrypted:${value}`).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString().slice(10) } };
  let api = await createLocalApi(options);
  t.after(async () => { await api.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const headers = { Authorization: 'Bearer connector-test', 'Content-Type': 'application/json' };
  const create = await fetch(`${api.origin}/api/local/connectors`, { method: 'POST', headers, body: JSON.stringify({ name: 'Original DB', type: 'postgres', settings: { host: 'localhost', port: 5432, username: 'app', database: 'old' }, secret: 'private-original' }) });
  assert.equal(create.status, 201);
  const row = await create.json();
  const update = async body => {
    const response = await fetch(`${api.origin}/api/local/connectors/${row.id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const changed = await update({ name: 'Edited DB', settings: { host: '10.62.172.112', port: 5432, database: 'new' } });
  assert.equal(changed.status, 200); assert.equal(changed.body.id, row.id);
  assert.equal(changed.body.hasCredential, true); assert.equal(changed.body.settings.username, 'app');
  assert.equal(JSON.stringify(changed.body).includes('private-original'), false);
  assert.equal(changed.body.createdAt, row.createdAt);
  assert.equal((await update({ settings: { host: '10.62.172.112:5432' } })).status, 400);
  assert.equal((await update({ type: 'mysql' })).status, 400);
  assert.equal((await update({ secret: 'private-replacement' })).body.hasCredential, true);
  assert.equal((await update({ secret: null })).body.hasCredential, false);
  await api.close(); api = await createLocalApi(options);
  const list = await fetch(`${api.origin}/api/local/connectors`, { headers });
  const rows = (await list.json()).items;
  assert.equal(rows.length, 1); assert.equal(rows[0].id, row.id);
  assert.equal(rows[0].settings.host, '10.62.172.112'); assert.equal(rows[0].settings.database, 'new');
  assert.equal(rows[0].hasCredential, false);
  const missing = await fetch(`${api.origin}/api/local/connectors/000000000000000000000000`, { method: 'PUT', headers, body: '{}' });
  assert.equal(missing.status, 404);
});
