const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const { LocalConnectorRuntime } = require('../src/local-connector-runtime.cjs');
const { createLocalApi } = require('../src/local-api.cjs');

test('Postgres metadata uses parameterized identifiers and read-only transactions', async (t) => {
  const queries = [];
  let database;
  t.mock.method(Client.prototype, 'connect', async function () { database = this.connectionParameters.database; });
  t.mock.method(Client.prototype, 'end', async () => {});
  t.mock.method(Client.prototype, 'query', async query => { queries.push(query); return { fields: [{ name: 'name' }], rows: [{ name: 'id' }], rowCount: 1 }; });
  const runtime = new LocalConnectorRuntime();
  const result = await runtime.metadata({ type: 'postgres', settings: { host: 'localhost', port: 5432, database: 'original' } }, '', { action: 'columns', database: 'selected', schema: 'odd.schema', table: "quoted'; DROP TABLE example; --" });
  assert.equal(database, 'selected'); assert.deepEqual(result.items, [{ name: 'id' }]);
  assert.equal(queries[0], 'BEGIN READ ONLY'); assert.equal(queries.at(-1), 'ROLLBACK');
  const actual = queries[1];
  assert.match(actual.text, /table_schema = \$1 AND table_name = \$2/);
  assert.deepEqual(actual.values, ['odd.schema', "quoted'; DROP TABLE example; --"]);
  assert.doesNotMatch(actual.text, /DROP TABLE/);
  await assert.rejects(runtime.metadata({ type: 'kafka', settings: {} }, '', { action: 'tables' }), /不支持数据库/);
});

test('MySQL metadata uses placeholders and the selected database', async (t) => {
  const queries = []; let database;
  t.mock.method(mysql, 'createConnection', async options => {
    database = options.database;
    return { beginTransaction: async () => {}, rollback: async () => {}, end: async () => {}, query: async (sql, values) => { queries.push({ sql, values }); return [[{ name: 'id' }], [{ name: 'name' }]]; } };
  });
  const runtime = new LocalConnectorRuntime();
  await runtime.metadata({ type: 'mysql', settings: { host: 'localhost', port: 3306, database: 'old' } }, '', { action: 'columns', database: 'new', schema: 'new', table: 'odd`name' });
  assert.equal(database, 'new'); assert.match(queries[1].sql, /TABLE_SCHEMA = \? AND TABLE_NAME = \?/);
  assert.deepEqual(queries[1].values, ['new', 'odd`name']);
});

test('real PostgreSQL Local API supports schema browsing and personal CRUD without approval', { skip: process.env.RUN_CONNECTOR_DB_TESTS !== '1' }, async () => {
  const schema = `desktop_details_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Client({ host: '127.0.0.1', port: 5432, user: 'codegen', password: 'codegen', database: 'codegen' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-metadata-db-'));
  let api;
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE TABLE "${schema}"."odd.table" (id integer PRIMARY KEY, value text)`);
    api = await createLocalApi({ storePath: path.join(directory, 'store.sqlite3'), credentialCodec: { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() } });
    const headers = { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' };
    const created = await fetch(`${api.origin}/api/local/connectors`, { method: 'POST', headers, body: JSON.stringify({ name: 'Fixture DB', type: 'postgres', settings: { host: '127.0.0.1', port: 5432, database: 'codegen', username: 'codegen' }, secret: 'codegen' }) });
    assert.equal(created.status, 201); const connector = await created.json();
    async function request(action, body) {
      const response = await fetch(`${api.origin}/api/local/connectors/${connector.id}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, 200, result.message); return result;
    }
    assert.ok((await request('metadata', { action: 'databases' })).items.some(item => item.name === 'codegen'));
    assert.ok((await request('metadata', { action: 'tables', database: 'codegen' })).items.some(item => item.schema === schema && item.name === 'odd.table'));
    const columns = await request('metadata', { action: 'columns', database: 'codegen', schema, table: 'odd.table' });
    assert.deepEqual(columns.items.map(item => item.name), ['id', 'value']);
    const table = `"${schema}"."odd.table"`;
    for (const sql of [`INSERT INTO ${table} VALUES (1, 'before')`, `UPDATE ${table} SET value = 'after' WHERE id = 1`]) {
      const result = await request('explore', { sql, database: 'codegen' });
      assert.equal(result.kind, 'command'); assert.equal(result.affectedRows, 1); assert.equal(result.approvalRequired, undefined);
    }
    assert.deepEqual((await request('explore', { sql: `SELECT * FROM ${table}`, database: 'codegen' })).rows, [{ id: 1, value: 'after' }]);
    assert.equal((await request('explore', { sql: `DELETE FROM ${table}`, database: 'codegen' })).affectedRows, 1);
  } finally {
    await api?.close();
    // Only remove the randomly named test schema created by this test.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
