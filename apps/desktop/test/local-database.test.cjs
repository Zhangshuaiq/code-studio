const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('pg');
const { createLocalApi } = require('../src/local-api.cjs');

test('personal Local API executes database CRUD without approval and enforces managed read-only access', { skip: process.env.RUN_LOCAL_DATABASE_TESTS !== '1' }, async (t) => {
  const configuration = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '../../api/.env')));
  const url = new URL(process.env.LOCAL_DATABASE_TEST_URL || configuration.DATABASE_URL);
  url.searchParams.delete('schema');
  const admin = new Client({ connectionString: url.toString() }); await admin.connect();
  const schema = `desktop_db_test_${crypto.randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-db-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519');
  const codec = { available: () => true, encrypt: (value) => Buffer.from(value).toString('base64'), decrypt: (value) => Buffer.from(value, 'base64').toString() };
  const api = await createLocalApi({ token: 'test-token', storePath: path.join(directory, 'local.sqlite3'), credentialCodec: codec, policyPublicKey: keys.publicKey, appVersion: '0.1.0' });
  t.after(() => api.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const created = await fetch(`${api.origin}/api/local/connectors`, { method: 'POST', headers, body: JSON.stringify({ name: 'CRUD test', type: 'postgres', settings: { host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)), username: decodeURIComponent(url.username) }, secret: decodeURIComponent(url.password) }) });
  assert.equal(created.status, 201); const connector = await created.json();
  async function execute(sql, extra = {}) {
    const response = await fetch(`${api.origin}/api/local/connectors/${connector.id}/explore`, { method: 'POST', headers, body: JSON.stringify({ sql, ...extra }) });
    return { status: response.status, body: await response.json() };
  }
  const table = `"${schema}"."items"`;
  assert.equal((await execute(`CREATE TABLE ${table} (id integer PRIMARY KEY, value text)`)).body.kind, 'command');
  const inserted = await execute(`INSERT INTO ${table} VALUES (1, 'first')`, { readOnly: true });
  assert.equal(inserted.status, 200); assert.equal(inserted.body.affectedRows, 1);
  assert.deepEqual((await execute(`SELECT * FROM ${table}`)).body.rows, [{ id: 1, value: 'first' }]);
  const updated = await execute(`UPDATE ${table} SET value = 'second' WHERE id = 1 RETURNING *`);
  assert.equal(updated.status, 200); assert.equal(updated.body.affectedRows, 1); assert.deepEqual(updated.body.rows, [{ id: 1, value: 'second' }]);
  assert.equal((await execute(`DELETE FROM ${table} WHERE id = 1`)).body.affectedRows, 1);
  assert.equal((await execute(`SELECT * FROM ${table}`)).body.rows.length, 0);
  // A trailing semicolon in a literal is valid; separate commands are not silently executed.
  assert.equal((await execute(`INSERT INTO ${table} VALUES (2, 'a;b')`)).status, 200);
  assert.equal((await execute(`DELETE FROM ${table}; INSERT INTO ${table} VALUES (3, 'batch')`)).status, 422);
  assert.equal((await execute(`SELECT * FROM ${table}`)).body.rows[0].id, 2);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'primary' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ organizationId: 'org-1', issuedAt: now - 1, expiresAt: now + 3600, offlineUntil: now + 7200, policy: { terminalEnabled: true, allowedModelEngines: [], allowedConnectorTypes: ['postgres'], allowedGitHosts: [], allowedNetworkHosts: [url.hostname], minimumClientVersion: '0.1.0' } })).toString('base64url');
  const token = `${header}.${payload}.${crypto.sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`;
  const installed = await fetch(`${api.origin}/api/local/enterprise/policy`, { method: 'POST', headers, body: JSON.stringify({ token }) });
  assert.equal(installed.status, 200);
  assert.equal((await execute(`UPDATE ${table} SET value = 'blocked'`, { readOnly: false })).status, 422);
  assert.equal((await execute(`WITH changed AS (DELETE FROM ${table} RETURNING *) SELECT * FROM changed`, { readOnly: false })).status, 422);
  assert.equal((await execute(`SELECT * FROM ${table}`)).body.rows[0].value, 'a;b');
});
