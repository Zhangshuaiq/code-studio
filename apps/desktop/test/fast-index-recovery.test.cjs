const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openRecoverableFastIndexStore: open } = require('@codegen/code-intelligence/recoverable-fast-index-store.cjs');
const { FastIndexClient } = require('@codegen/code-intelligence/fast-index-client.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-index-recovery-'));
  const root = fs.realpathSync(directory), database = path.join(root, 'index.sqlite3');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { root, database };
}
test('owned corrupt cache is quarantined with sidecars and rebuilt without touching source', async t => {
  const { root, database } = fixture(t);
  const source = 'class RecoveredService { void work() {} }';
  fs.writeFileSync(path.join(root, 'A.java'), source);
  let client = new FastIndexClient({ root, databasePath: database });
  t.after(() => client.close());
  await client.refresh(); await client.close();
  const corrupt = Buffer.from('broken sqlite cache');
  fs.writeFileSync(database, corrupt);
  fs.writeFileSync(database + '-wal', 'preserve-wal');
  fs.writeFileSync(database + '-shm', 'preserve-shm');
  client = new FastIndexClient({ root, databasePath: database });
  const status = await client.status();
  assert.equal(status.complete, false);
  assert.equal(status.cacheRecovery.reason, 'sqlite-corruption');
  assert.equal((await client.search('Recovered')).items.length, 0);
  const scan = await client.refresh();
  assert.equal(scan.complete, true); assert.equal(scan.parsedFiles, 1);
  assert.equal((await client.search('Recovered')).items[0].name, 'RecoveredService');
  assert.equal(fs.readFileSync(path.join(root, 'A.java'), 'utf8'), source);
  const backups = fs.readdirSync(root).filter(name => name.startsWith('index.sqlite3.corrupt-'));
  assert.equal(backups.length, 1);
  const backup = path.join(root, backups[0]);
  assert.deepEqual(fs.readFileSync(path.join(backup, 'index.sqlite3')), corrupt);
  assert.equal(fs.readFileSync(path.join(backup, 'index.sqlite3-wal'), 'utf8'), 'preserve-wal');
  assert.equal(fs.readFileSync(path.join(backup, 'index.sqlite3-shm'), 'utf8'), 'preserve-shm');
  assert.ok(!JSON.stringify(status).includes(root), 'recovery status must not expose cache paths');
  await client.close();
  client = new FastIndexClient({ root, databasePath: database });
  assert.equal((await client.search('Recovered')).items.length, 1);
  assert.equal((await client.refresh()).parsedFiles, 0);
});
test('unknown corrupt files, foreign databases, newer schemas and different roots are never replaced', t => {
  const { root, database } = fixture(t);
  fs.writeFileSync(database, 'unknown corrupt file');
  assert.throws(() => open(database, root));
  assert.equal(fs.readFileSync(database, 'utf8'), 'unknown corrupt file');
  assert.deepEqual(fs.readdirSync(root), ['index.sqlite3']);
  const business = path.join(root, 'business.sqlite3');
  const db = new DatabaseSync(business); db.exec('CREATE TABLE accounts(value TEXT); INSERT INTO accounts VALUES(\'preserved\');'); db.close();
  assert.throws(() => open(business, root), /not owned/);
  assert.equal(fs.existsSync(business + '.owner.json'), false);
  const owned = path.join(root, 'owned.sqlite3'); open(owned, root).close();
  assert.throws(() => open(owned, path.join(root, 'other')), { code: 'FAST_INDEX_CACHE_IDENTITY' });
  const newer = new DatabaseSync(owned); newer.exec('PRAGMA user_version=999'); newer.close();
  assert.throws(() => open(owned, root), /newer/);
  assert.equal(fs.readdirSync(root).some(name => name.includes('.corrupt-')), false);
});
test('marker corruption and linked database, marker or sidecar fail closed without changing their targets', t => {
  const { root, database } = fixture(t);
  open(database, root).close();
  const marker = database + '.owner.json';
  const saved = fs.readFileSync(marker);
  fs.writeFileSync(marker, '{not json');
  assert.throws(() => open(database, root), { code: 'FAST_INDEX_CACHE_IDENTITY' });
  fs.writeFileSync(marker, saved);
  const target = path.join(root, 'do-not-touch.txt'); fs.writeFileSync(target, 'preserved');
  const savedDatabase = fs.readFileSync(database);
  for (const file of [database, database + '-wal', marker]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.symlinkSync(target, file);
    assert.throws(() => open(database, root), { code: 'FAST_INDEX_UNSAFE_CACHE' });
    fs.unlinkSync(file);
    if (file === marker) fs.writeFileSync(marker, saved);
    if (file === database) fs.writeFileSync(database, savedDatabase);
  }
  fs.linkSync(target, database + '-shm');
  assert.throws(() => open(database, root), { code: 'FAST_INDEX_UNSAFE_CACHE' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserved');
  assert.equal(fs.readdirSync(root).some(name => name.includes('.corrupt-')), false);
});
test('valid pre-marker caches are adopted without dropping symbols', t => {
  const { root, database } = fixture(t);
  const { FastIndexStore } = require('@codegen/code-intelligence/fast-index-store.cjs');
  const prior = new FastIndexStore(database, root), generation = prior.beginScan();
  prior.replace('A.java', 'stamp', 'hash', { symbols: [{ name: 'KeptService', kind: 'class', line: 1, column: 7 }] }, generation);
  prior.finishScan(generation); prior.close();
  const adopted = open(database, root);
  try { assert.equal(adopted.search('Kept').items.length, 1); assert.equal(adopted.status().cacheRecovery, undefined); }
  finally { adopted.close(); }
  assert.ok(fs.existsSync(database + '.owner.json'));
});

test('owned schema corruption with a valid SQLite header also rebuilds', t => {
  const { root, database } = fixture(t);
  open(database, root).close();
  const corrupt = fs.readFileSync(database);
  corrupt.fill(0, 100, Math.min(corrupt.length, 4096));
  fs.writeFileSync(database, corrupt);
  const restored = open(database, root);
  try { assert.equal(restored.status().cacheRecovery.reason, 'sqlite-corruption'); assert.equal(restored.status().files, 0); }
  finally { restored.close(); }
  const backup = fs.readdirSync(root).find(name => name.includes('.corrupt-'));
  assert.ok(fs.readFileSync(path.join(root, backup, 'index.sqlite3')).equals(corrupt));
});
