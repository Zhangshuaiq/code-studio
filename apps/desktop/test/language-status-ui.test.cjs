const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const filename = path.resolve(__dirname, '../../web/src/components/Desktop/DesktopLanguageStatus.tsx');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const componentModule = new Module(filename, module);
componentModule.filename = filename;
componentModule.paths = Module._nodeModulePaths(path.dirname(filename));
componentModule._compile(compiled, filename);
const { DesktopLanguageStatus, isLanguageStartupError, fastIndexStatusText } = componentModule.exports;

test('language startup uses a compact indeterminate status, not an error alert or invented percentage', () => {
  const html = renderToStaticMarkup(React.createElement(DesktopLanguageStatus, { projectId: 'test', active: true }));
  assert.match(html, /正在加载代码智能/);
  assert.match(html, /role="status"/);
  assert.match(html, /role="progressbar"/);
  assert.doesNotMatch(html, /role="alert"|aria-valuenow|初始化超时/);
});

test('only language startup failures are moved to the non-blocking status bar', () => {
  for (const code of ['LOCAL_LSP_UNAVAILABLE', 'LOCAL_LSP_TIMEOUT', 'LSP_CAPACITY_EXCEEDED']) assert.equal(isLanguageStartupError({ code }), true);
  for (const code of ['LOCAL_LSP_REFACTOR_UNSUPPORTED', 'WORKSPACE_PATH_INVALID', 'LOCAL_FILE_CHANGED']) assert.equal(isLanguageStartupError({ code }), false);
});
test('fast-index readiness is separate from Java loading and incomplete coverage is never called ready', () => {
  assert.equal(fastIndexStatusText(), '');
  assert.equal(fastIndexStatusText({ state: 'ready', files: 1647, complete: true }), '快速索引就绪 · 1647 文件');
  assert.match(fastIndexStatusText({ state: 'needs-validation', files: 1647, complete: false }), /缓存符号可用.*后台校验/);
  assert.match(fastIndexStatusText({ state: 'scanning', files: 0, complete: false }), /正在建立/);
  assert.match(fastIndexStatusText({ state: 'ready', files: 2, complete: false }), /部分可用/);
  assert.doesNotMatch(fastIndexStatusText({ state: 'ready', files: 2, complete: true, backgroundError: 'FAST_INDEX_ERROR' }), /索引就绪/);
});
