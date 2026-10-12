const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../web/src/lib/fast-index-drafts.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {}; new Function('exports', output)(exported);
const { collectJavaDrafts } = exported;
test('shared renderer draft collection includes empty Java edits and excludes saved, non-Java and readonly files', () => {
  const files = [
    { path: 'A.java', content: '', baseline: 'class Old {}' },
    { path: 'B.java', content: 'class Saved {}', baseline: 'class Saved {}' },
    { path: 'main.ts', content: 'changed', baseline: 'old' },
    { path: '@java-source/reference/External.java', content: 'changed', baseline: 'old' },
    { path: 'ReadOnly.java', content: 'changed', baseline: 'old', readOnly: true },
  ];
  assert.deepEqual(collectJavaDrafts(files), [{ path: 'A.java', content: '' }]);
});
test('draft collection reports omitted coverage instead of silently truncating documents or UTF-8 payload', () => {
  const file = { path: 'A.java', content: 'changed', baseline: 'old' };
  assert.throws(() => collectJavaDrafts(Array.from({ length: 21 }, (_, i) => ({ ...file, path: `A${i}.java` }))), /先保存/);
  assert.throws(() => collectJavaDrafts([{ ...file, content: '中'.repeat(300000) }]), /先保存/);
  assert.throws(() => collectJavaDrafts([{ ...file, content: 'x'.repeat(500001) }]), /先保存/);
});
