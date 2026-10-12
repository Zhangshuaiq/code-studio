const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JavaFastIndex } = require('@codegen/code-intelligence/java-fast-index.cjs');
const { encodeText } = require('@codegen/code-intelligence/file-text.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-fast-index-'));
  const root = path.join(directory, 'project'); fs.mkdirSync(root);
  let index = new JavaFastIndex({ root, databasePath: path.join(directory, 'symbols.sqlite3') });
  t.after(async () => { await index.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { root, directory, get index() { return index; }, write(file, content) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); }, async reopen() { await index.close(); index = new JavaFastIndex({ root, databasePath: path.join(directory, 'symbols.sqlite3') }); return index; } };
}
test('BOM and UTF-16 Java symbols use decoded coordinates and retain raw-byte hash across warm reopen', async t => {
  const f = fixture(t);
  for (const [name, format] of [['Bom', { encoding: 'utf-8', bom: true }], ['Little', { encoding: 'utf-16le', bom: true }], ['Big', { encoding: 'utf-16be', bom: true }]]) f.write(`${name}.java`, encodeText(`class ${name} { void hello() {} }`, format));
  const first = await f.index.refresh(); assert.equal(first.parsedFiles, 3); assert.equal(first.rejectedFiles, 0);
  for (const name of ['Bom', 'Little', 'Big']) {
    const symbol = (await f.index.search(name)).items.find(item => item.name === name); assert.ok(symbol); assert.equal(symbol.column, 7);
    assert.equal(symbol.hash, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(f.root, `${name}.java`))).digest('hex'));
  }
  await f.reopen(); const warm = await f.index.refresh(); assert.equal(warm.unchangedFiles, 3); assert.equal(warm.parsedFiles, 0);
});
test('full project indexing exceeds 500 files and warm reopen avoids source reparsing', async t => {
  const f = fixture(t);
  for (let i = 0; i < 505; i++) f.write(`File${i}.java`, `class Symbol${i} { void run${i}() {} }`);
  const first = await f.index.refresh(); assert.equal(first.complete, true); assert.equal(first.parsedFiles, 505);
  assert.equal((await f.index.search('Symbol504')).items.length, 1);
  await f.reopen(); assert.equal((await f.index.search('Symbol504')).items.length, 1);
  const second = await f.index.refresh(); assert.equal(second.parsedFiles, 0); assert.equal(second.unchangedFiles, 505);
  assert.equal((await f.index.outline('File504.java')).items.length, 2);
});
test('incremental saved changes, unchanged hashes, deletion and skipped outputs are handled', async t => {
  const f = fixture(t); f.write('A.java', 'class First {}'); f.write('target/Excluded.java', 'class Excluded {}');
  await f.index.refresh(); assert.equal(f.index.status().files, 1);
  f.write('A.java', 'class Second {}'); const changed = await f.index.refresh(); assert.equal(changed.parsedFiles, 1);
  assert.equal((await f.index.search('First')).items.length, 0); assert.equal((await f.index.search('Second')).items.length, 1);
  f.write('A.java', 'class Second {}'); const same = await f.index.refresh(); assert.equal(same.parsedFiles, 0);
  fs.unlinkSync(path.join(f.root, 'A.java')); await f.index.refresh(); assert.equal(f.index.status().files, 0);
});
test('oversized and binary Java files are explicit omissions and outside symlinks are never indexed', async t => {
  const f = fixture(t); f.write('Huge.java', 'x'.repeat(1024 * 1024 + 1)); f.write('Binary.java', Buffer.from([0, 1]));
  fs.writeFileSync(path.join(f.directory, 'outside.java'), 'class OutsideSecret {}');
  fs.symlinkSync(path.join(f.directory, 'outside.java'), path.join(f.root, 'linked.java'));
  const result = await f.index.refresh(); assert.equal(result.rejectedFiles, 2); assert.equal(result.complete, false);
  assert.equal((await f.index.search('OutsideSecret')).items.length, 0);
});
test('refresh coalescing cancels superseded jobs and close rejects new work', async t => {
  const f = fixture(t); f.write('A.java', 'class Latest {}');
  const first = f.index.refresh(); const second = f.index.refresh();
  assert.equal((await first).cancelled, true); assert.equal((await second).complete, true);
  await f.index.close(); await assert.rejects(f.index.refresh(), /closed/);
});
