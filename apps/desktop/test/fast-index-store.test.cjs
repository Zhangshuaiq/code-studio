const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FastIndexStore } = require('@codegen/code-intelligence/fast-index-store.cjs');
const { JavaSyntaxIndex } = require('@codegen/code-intelligence/java-syntax-index.cjs');
const { DatabaseSync } = require('node:sqlite');
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-index-store-'));
  let store = new FastIndexStore(path.join(directory, 'symbols.sqlite3'), directory);
  const parser = await JavaSyntaxIndex.create();
  t.after(() => { store.close(); parser.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, parser, get store() { return store; }, reopen(version) { store.close(); store = new FastIndexStore(path.join(directory, 'symbols.sqlite3'), directory, version); return store; } };
}
test('persistent symbol store searches substring, short names and camel abbreviation and restores metadata', async t => {
  const f = await fixture(t); const generation = f.store.beginScan();
  const source = 'package demo; class CustomerOrderService { void buildOrder(){} String 中文; }';
  const parsed = f.parser.parse(source, 'CustomerOrderService.java'); parsed.source = 'MUST NOT PERSIST';
  f.store.replace(parsed.path, 'stamp', 'content-hash', parsed, generation); f.store.finishScan(generation);
  assert.equal(f.store.search('OrderService').items[0].name, 'CustomerOrderService');
  assert.equal(f.store.search('cos').items[0].name, 'CustomerOrderService');
  assert.equal(f.store.search('中文').items[0].kind, 'field');
  assert.equal(f.store.search('bo').items[0].name, 'buildOrder');
  assert.equal(f.store.search('" OR "').items.length, 0);
  assert.equal(f.store.outline(parsed.path).length, 3);
  f.reopen(); assert.equal(f.store.status().complete, true);
  assert.equal(f.store.search('build').items[0].packageName, 'demo');
  assert.equal(fs.readFileSync(path.join(f.directory, 'symbols.sqlite3')).includes(Buffer.from('MUST NOT PERSIST')), false);
  assert.equal(f.store.search('build').items[0].hash, 'content-hash');
});
test('incremental replacement and deletion remove old FTS symbols; stale generations cannot write', async t => {
  const f = await fixture(t); let generation = f.store.beginScan();
  f.store.replace('A.java', '1', '1', f.parser.parse('class FirstVersion {}', 'A.java'), generation); f.store.finishScan(generation);
  const obsolete = generation; generation = f.store.beginScan();
  f.store.replace('A.java', '2', '2', f.parser.parse('class SecondVersion {}', 'A.java'), generation); f.store.finishScan(generation);
  assert.equal(f.store.search('FirstVersion').items.length, 0); assert.equal(f.store.search('SecondVersion').items.length, 1);
  assert.throws(() => f.store.markSeen('A.java', obsolete), { code: 'FAST_INDEX_STALE' });
  generation = f.store.beginScan(); f.store.finishScan(generation);
  assert.equal(f.store.search('Version').items.length, 0);
});
test('interrupted scans and omitted files are not declared complete; unreadable directories retain old entries', async t => {
  const f = await fixture(t); const generation = f.store.beginScan();
  f.store.replace('A.java', '1', '1', f.parser.parse('class KeepMe {}', 'A.java'), generation);
  f.reopen(); assert.equal(f.store.status().state, 'scanning'); assert.equal(f.store.search('KeepMe').sourceTruncated, true);
  const next = f.store.beginScan(); f.store.finishScan(next, 1);
  assert.equal(f.store.search('KeepMe').items.length, 1); assert.equal(f.store.status().complete, false);
  const final = f.store.beginScan(); f.store.markSeen('A.java', final);
  f.store.replace('Big.java', '1', '', { symbols: [], truncated: true }, final, true); f.store.finishScan(final);
  assert.equal(f.store.status().rejectedFiles, 1); assert.equal(f.store.status().complete, false);
});
test('parser upgrades invalidate derived caches and rejected transactions retain prior contents', async t => {
  const f = await fixture(t); const generation = f.store.beginScan();
  f.store.replace('A.java', '1', '1', f.parser.parse('class PriorContent {}', 'A.java'), generation); f.store.finishScan(generation);
  assert.throws(() => f.store.replace('A.java', '2', '2', { symbols: [{ name: 'Bad', line: 0, column: 1 }] }, generation));
  assert.equal(f.store.search('Prior').items.length, 1);
  assert.throws(() => f.store.remove('../Outside.java'), /relative/);
  f.reopen('next-parser'); assert.equal(f.store.status().files, 0); assert.equal(f.store.status().state, 'needs-scan');
});
test('index initialization refuses foreign databases and mismatched roots without deleting data', async t => {
  const f = await fixture(t);
  const foreign = path.join(f.directory, 'business.sqlite3');
  let business = new DatabaseSync(foreign);
  business.exec("CREATE TABLE business(value TEXT); INSERT INTO business VALUES('keep-me');"); business.close();
  assert.throws(() => new FastIndexStore(foreign, f.directory), /not owned/);
  business = new DatabaseSync(foreign);
  assert.equal(business.prepare('SELECT value FROM business').get().value, 'keep-me'); business.close();
  assert.throws(() => new FastIndexStore(path.join(f.directory, 'symbols.sqlite3'), path.join(f.directory, 'another')), /different workspace/);
  assert.equal(f.store.meta('root'), f.directory);
});
