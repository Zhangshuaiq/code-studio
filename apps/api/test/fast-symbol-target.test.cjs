const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../web/src/lib/fast-symbol-target.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {}; new Function('exports', output)(exported);
const { verifyFastSymbolTarget } = exported;
const target = (content, extras = {}) => ({ path: 'A.java', name: 'Service', line: 2, column: 7, hash: createHash('sha256').update(content).digest('hex'), hashSource: 'disk', ...extras });
test('fast symbol validates exact disk/overlay content, line endings and UTF-16 cursor coordinates', async () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const content = `// 😀 示例${eol}class Service {}`;
    await verifyFastSymbolTarget(target(content), content);
    await verifyFastSymbolTarget(target(content, { hashSource: 'overlay' }), content);
  }
  const unicode = 'class 中文 { String emoji="😀"; void 方法() {} }';
  await verifyFastSymbolTarget(target(unicode, { name: '方法', line: 1, column: unicode.indexOf('方法') + 1 }), unicode);
});
test('modified content, incorrect coordinates, missing versions and unsafe targets never open old positions', async () => {
  const content = '\nclass Service {}';
  for (const candidate of [target(content, { column: 6 }), target(content, { line: 3 }), target(content, { hash: '' }), target(content, { hashSource: 'unknown' }), target(content, { path: '../A.java' }), target(content, { path: 'C:\\A.java' }), target(content, { path: '/etc/A.java' })]) {
    await assert.rejects(verifyFastSymbolTarget(candidate, content), { code: 'FAST_SYMBOL_STALE' });
  }
  await assert.rejects(verifyFastSymbolTarget(target(content), '\n\nclass Service {}'), { code: 'FAST_SYMBOL_STALE' });
});
