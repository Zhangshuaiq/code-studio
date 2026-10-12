const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FastIndexClient } = require('@codegen/code-intelligence/fast-index-client.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-fast-overlay-'));
  const root = path.join(directory, 'project'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'A.java'), 'class DiskService { void diskMethod() {} }');
  const client = new FastIndexClient({ root, databasePath: path.join(directory, 'index.sqlite3') });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, client };
}
test('request-local Java overlays replace disk symbols and outline without persisting or leaking into later queries', async t => {
  const { client, root, directory } = fixture(t); await client.refresh();
  const baseline = await client.status();
  const content = '// 草稿 😀\n\nclass DraftService { void unsavedMethod() {} }';
  const documents = [{ path: 'A.java', content }];
  const draft = await client.search('Service', 200, documents);
  assert.deepEqual(draft.items.map(item => item.name), ['DraftService']);
  assert.equal(draft.overlayApplied, true); assert.equal(draft.items[0].line, 3); assert.equal(draft.items[0].hashSource, 'overlay');
  assert.equal((await client.search('DiskService', 200, documents)).items.length, 0);
  assert.equal((await client.outlineWithDocuments('A.java', documents)).items[1].name, 'unsavedMethod');
  assert.equal((await client.search('DiskService')).items.length, 1);
  assert.deepEqual(await client.status(), baseline);
  assert.ok(fs.readFileSync(path.join(root, 'A.java'), 'utf8').includes('DiskService'));
  await client.close();
  assert.equal(fs.readFileSync(path.join(directory, 'index.sqlite3')).includes(Buffer.from('DraftService')), false);
});
test('overlay exclusions happen before SQL result limits and empty drafts hide all old declarations', async t => {
  const { client, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'A.java'), Array.from({ length: 300 }, (_, i) => `class Match${i} {}`).join('\n'));
  fs.writeFileSync(path.join(root, 'B.java'), 'class OtherMatch {}');
  await client.refresh();
  const result = await client.search('Match', 1, [{ path: 'A.java', content: '' }]);
  assert.deepEqual(result.items.map(item => item.name), ['OtherMatch']); assert.equal(result.truncated, false);
  const fresh = await client.search('Fresh', 200, [{ path: 'New.java', content: 'class Fresh {}' }]);
  assert.equal(fresh.items[0].path, 'New.java'); assert.equal(fs.existsSync(path.join(root, 'New.java')), false);
});
test('overlay validation rejects unsafe paths, links, duplicate documents, NUL and aggregate budgets', async t => {
  const { client, root, directory } = fixture(t);
  fs.writeFileSync(path.join(directory, 'Outside.java'), 'class Outside {}');
  fs.symlinkSync(path.join(directory, 'Outside.java'), path.join(root, 'Linked.java'));
  const invalid = [
    [{ path: '../Outside.java', content: 'class Outside {}' }],
    [{ path: 'Linked.java', content: 'class Fake {}' }],
    [{ path: '/etc/Secret.java', content: 'class Fake {}' }],
    [{ path: 'C:\\Secret.java', content: 'class Fake {}' }],
    [{ path: 'A.java', content: '\0' }],
    [{ path: 'A.java', content: '' }, { path: 'A.java', content: 'class Duplicate {}' }],
    [{ path: 'A.java', content: '中'.repeat(400000) }],
    Array.from({ length: 21 }, (_, i) => ({ path: `New${i}.java`, content: '' })),
  ];
  for (const documents of invalid) await assert.rejects(client.search('Service', 200, documents), { code: 'FAST_INDEX_OVERLAY_INVALID' });
});
test('concurrent disk scan and overlay parsing share parser initialization and preserve request isolation', async t => {
  const { client } = fixture(t);
  const scan = client.refresh();
  const results = await Promise.all(['One', 'Two', 'Three'].map(name => client.search('Service', 200, [{ path: 'A.java', content: `class ${name}Service {}` }])));
  for (let i = 0; i < results.length; i++) assert.deepEqual(results[i].items.map(item => item.name), [['OneService'], ['TwoService'], ['ThreeService']][i]);
  assert.equal((await scan).complete, true);
  assert.equal((await client.search('Service')).items[0].name, 'DiskService');
});
