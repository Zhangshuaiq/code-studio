const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const Module = require('node:module'); const ts = require('typescript');
const filename = path.resolve(__dirname, '../../web/src/lib/editor-appearance.ts');
const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);
const { importAppearance, exportAppearance, validateAppearance } = compiled.exports;
test('every bundled palette is valid and survives preference export/import', () => {
  const { presets } = require('../../../packages/code-intelligence/editor-appearance.cjs');
  assert.equal(Object.keys(presets).length, 13);
  for (const [name, palette] of Object.entries(presets)) {
    const appearance = validateAppearance({ theme: name });
    assert.deepEqual(importAppearance(exportAppearance(appearance)), appearance);
    const custom = validateAppearance({ theme: 'custom', customTheme: palette });
    assert.equal(custom.customTheme.base, palette.base);
    assert.deepEqual(importAppearance(exportAppearance(custom)), custom);
    assert.ok(palette.rules.some(rule => rule.token === 'keyword'));
  }
});
test('editor style exports/imports losslessly including complete Monaco themes', () => {
  const appearance = validateAppearance({ fontSize: 17, fontFamily: 'JetBrains Mono, monospace', lineHeight: 26, fontLigatures: true, wordWrap: 'on', theme: 'custom', customTheme: { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '008000', fontStyle: 'italic' }], colors: { 'editor.background': '#123456' } } });
  assert.deepEqual(importAppearance(exportAppearance(appearance)), appearance);
  assert.deepEqual(importAppearance(JSON.stringify(appearance.customTheme)).customTheme, appearance.customTheme);
  assert.equal(JSON.parse(exportAppearance(appearance)).version, 1);
});
test('editor style imports reject unsupported/oversized/malformed data before changing preferences', () => {
  for (const content of ['{', 'null', '[]', '{"name":"ordinary JSON document"}', JSON.stringify({ format: 'code-studio-editor-style', version: 2, appearance: {} }), JSON.stringify({ fontSize: 99 }), JSON.stringify({ fontFamily: 'url(https://example.com/x)' }), ' '.repeat(128 * 1024 + 1)]) assert.throws(() => importAppearance(content));
});
test('large valid styles remain importable after exporting current settings', () => {
  const appearance = validateAppearance({ theme: 'custom', customTheme: { base: 'vs-dark', inherit: true, rules: Array.from({length:500},(_,i)=>({token:'t'+i+'.'+'x'.repeat(110),foreground:'abcdef',fontStyle:'italic bold'})), colors:Object.fromEntries(Array.from({length:200},(_,i)=>['color'+i+'.'+'x'.repeat(80),'#123456'])) } });
  const exported = exportAppearance(appearance);
  assert.ok(new TextEncoder().encode(exported).length <= 128 * 1024);
  assert.deepEqual(importAppearance(exported), appearance);
});
