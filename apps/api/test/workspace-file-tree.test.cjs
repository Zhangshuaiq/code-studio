const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../web/src/lib/workspace-file-tree.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exported = {}; new Function('exports', output)(exported);
const { buildWorkspaceFileTree: build } = exported;
test('web paths and desktop file entries produce the same sorted hierarchy', () => {
  const files = ['src/B.java', 'readme.md', 'src/nested/A.java', 'src/A.java'];
  assert.deepEqual(build(files), build(files.map(path => ({ path, type: 'file' }))));
  const tree = build(files);
  assert.equal(tree[0].name, 'src');
  assert.deepEqual(tree[0].children.map(node => node.name), ['nested', 'A.java', 'B.java']);
  assert.equal(tree[0].children[0].children[0].path, 'src/nested/A.java');
});
test('empty folders, duplicate entries and arbitrary ordering retain valid nodes', () => {
  const tree = build([{ path: 'empty', type: 'directory' }, { path: 'deep/empty', type: 'directory' }, 'src/A.java', { path: 'src', type: 'directory' }, 'src/A.java']);
  assert.equal(tree.find(node => node.path === 'empty').isDir, true);
  assert.equal(tree.find(node => node.path === 'deep').children[0].isDir, true);
  assert.equal(tree.find(node => node.path === 'src').children.length, 1);
  assert.deepEqual(build(['../escape', '/absolute', 'bad//path', './file', '', 'valid.java']).map(node => node.path), ['valid.java']);
});
test('large flat directories and deep paths are built without truncation or recursive sorting', () => {
  const files = Array.from({ length: 10000 }, (_, index) => `wide/File${index}.java`);
  const tree = build(files);
  assert.equal(tree[0].children.length, 10000);
  assert.ok(tree[0].children.some(node => node.path === 'wide/File9999.java'));
  const deep = Array.from({ length: 1500 }, (_, index) => `d${index}`).join('/') + '/A.java';
  let node = build([deep])[0];
  for (let index = 1; index < 1500; index++) node = node.children[0];
  assert.equal(node.children[0].path, deep);
});
