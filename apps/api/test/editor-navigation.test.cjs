const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const Module = require('node:module'); const ts = require('typescript');
// Compile the actual frontend source in memory; no generated test files or
// parallel implementation of the history state machine.
function loadSource(relative, overrides = {}) {
  const filename = path.resolve(__dirname, '../../web/src', relative);
  const compiled = new Module(filename, module); compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireOriginal = compiled.require.bind(compiled); compiled.require = (id) => Object.hasOwn(overrides, id) ? overrides[id] : requireOriginal(id);
  compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
  return compiled.exports;
}
const helpers = loadSource('lib/editor-navigation.ts');
const { useEditorTabs: tabs } = loadSource('store/editorTabs.ts', { '../lib/editor-navigation': helpers });
const point = helpers.editorLocation;
const keymap = loadSource('lib/editor-keymap.ts');
test('IDEA, VS Code and Eclipse cursor navigation shortcuts are platform-aware and do not capture editing keys', () => {
  const event = (code, flags = {}) => ({ code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...flags });
  assert.equal(keymap.navigationDirection('idea', 'MacIntel', event('BracketLeft', { metaKey: true })), -1);
  assert.equal(keymap.navigationDirection('idea', 'MacIntel', event('BracketRight', { metaKey: true })), 1);
  assert.equal(keymap.navigationDirection('idea', 'Win32', event('ArrowLeft', { ctrlKey: true, altKey: true })), -1);
  assert.equal(keymap.navigationDirection('vscode', 'MacIntel', event('Minus', { ctrlKey: true })), -1);
  assert.equal(keymap.navigationDirection('vscode', 'MacIntel', event('Minus', { ctrlKey: true, shiftKey: true })), 1);
  assert.equal(keymap.navigationDirection('vscode', 'Linux', event('Minus', { ctrlKey: true, altKey: true })), -1);
  assert.equal(keymap.navigationDirection('eclipse', 'MacIntel', event('ArrowRight', { altKey: true })), 1);
  assert.equal(keymap.navigationDirection('vscode', 'Win32', event('ArrowLeft', { altKey: true })), -1);
  assert.equal(keymap.navigationDirection('idea', 'MacIntel', event('ArrowLeft', { altKey: true })), 0);
  assert.equal(keymap.navigationDirection('vscode', 'MacIntel', event('Minus', { metaKey: true })), 0);
  assert.equal(keymap.navigationDirection('eclipse', 'Win32', event('ArrowLeft')), 0);
});
test.beforeEach(() => tabs.getState().closeAllFiles());

test('code jumps record exact origin and destination, and back/forward restore positions without losing drafts', () => {
  tabs.getState().openFile('Main.java'); tabs.getState().syncDraft('Main.java', 'baseline'); tabs.getState().setDraftContent('Main.java', 'unsaved');
  tabs.getState().jumpToLocation(point('Main.java', 7, 24), point('Greeting.java', 2, 10));
  tabs.getState().restoreHistory(0, point('Greeting.java', 3, 12));
  assert.equal(tabs.getState().activeFile, 'Main.java'); assert.deepEqual(tabs.getState().navigation, point('Main.java', 7, 24));
  assert.equal(tabs.getState().drafts['Main.java'].content, 'unsaved');
  tabs.getState().restoreHistory(1, point('Main.java', 8, 25));
  assert.deepEqual(tabs.getState().navigation, point('Greeting.java', 3, 12));
  assert.deepEqual(tabs.getState().navigationHistory[0], point('Main.java', 8, 25));
});
test('a new jump after going back truncates forward history and keeps the new origin cursor', () => {
  tabs.getState().jumpToLocation(point('Main.java', 7, 24), point('Greeting.java', 2, 10));
  tabs.getState().jumpToLocation(point('Greeting.java', 4, 15), point('Dependency.java', 20, 9));
  tabs.getState().restoreHistory(1);
  tabs.getState().jumpToLocation(point('Greeting.java', 6, 18), point('Other.java', 30, 2));
  assert.deepEqual(tabs.getState().navigationHistory, [point('Main.java', 7, 24), point('Greeting.java', 6, 18), point('Other.java', 30, 2)]);
  assert.equal(tabs.getState().navigationHistoryIndex, 2);
});
test('history supports same-file navigation, dependency sources and reopening a closed target', () => {
  const source = '@java-source/aaaaaaaaaaaaaaaaaaaaaaaa/String.java';
  tabs.getState().jumpToLocation(point('Main.java', 7, 24), point('Main.java', 50, 1));
  tabs.getState().jumpToLocation(point('Main.java', 50, 1), point(source, 120, 5));
  tabs.getState().closeFile(source); tabs.getState().restoreHistory(1); tabs.getState().restoreHistory(2);
  assert.ok(tabs.getState().openFiles.includes(source)); assert.deepEqual(tabs.getState().navigation, point(source, 120, 5));
});
test('empty, out-of-range and same-position history operations are harmless', () => {
  const before = tabs.getState(); tabs.getState().restoreHistory(-1); tabs.getState().restoreHistory(0);
  assert.equal(tabs.getState(), before);
  const empty = { entries: [], index: -1 }; assert.equal(helpers.appendNavigation(empty, point('Main.java'), point('Main.java')), empty);
  assert.deepEqual(point('Main.java', NaN, -5), point('Main.java', 1, 1));
});
test('history is bounded to 100 points and resets when closing the workspace or changing branches', () => {
  for (let index = 0; index < 120; index++) tabs.getState().jumpToLocation(point(`${index}.java`, index + 1), point(`${index + 1}.java`, index + 2));
  assert.equal(tabs.getState().navigationHistory.length, 100); assert.equal(tabs.getState().navigationHistoryIndex, 99);
  tabs.getState().resetForBranch(['120.java']); assert.deepEqual(tabs.getState().navigationHistory, []); assert.equal(tabs.getState().navigationHistoryIndex, -1);
  tabs.getState().jumpToLocation(point('120.java'), point('121.java')); tabs.getState().closeAllFiles();
  assert.deepEqual(tabs.getState().navigationHistory, []); assert.equal(tabs.getState().navigationHistoryIndex, -1);
});

function providerFixture(transport, prepareLocations, options = {}) {
  const providers = new Map(); const disposable = { dispose() {} };
  const languages = {};
  for (const kind of ['Definition', 'Declaration', 'TypeDefinition', 'Implementation', 'Reference', 'Hover', 'DocumentSymbol', 'CompletionItem', 'Rename', 'CodeAction', 'CallHierarchy']) {
    languages[`register${kind}Provider`] = (language, provider) => { providers.set(`${typeof language === 'string' ? language : language.language}:${kind}`, provider); return disposable; };
  }
  const monaco = {
    languages, Range: class { constructor(startLineNumber, startColumn, endLineNumber, endColumn) { Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn }); } },
    Uri: { parse: (uri) => { const value = new URL(uri); return { scheme: value.protocol.slice(0, -1), authority: value.host, path: value.pathname }; } },
    editor: { getModels: () => [], getEditors: () => [], onDidCreateModel: () => disposable },
  };
  const source = loadSource('lib/monaco.ts', { '@monaco-editor/react': { loader: { config() {} } } });
  const installed = source.installWorkspaceLanguageProviders(monaco, 'session', transport, { prepareLocations, ...options });
  let version = 1; let disposed = false;
  const model = { uri: monaco.Uri.parse('codegen://session/Main.java'), getVersionId: () => version, getValue: () => 'class Main {}', isDisposed: () => disposed };
  return { providers, installed, model, edit: () => version++, disposeModel: () => { disposed = true; } };
}
test('Java document outline uses current-buffer fast syntax without waiting for semantic initialization', async () => {
  const calls = [];
  const fixture = providerFixture(async (operation, input) => {
    calls.push({ operation, input });
    assert.equal(operation, 'fast-document-symbols');
    return { items: [{ name: 'Main', kind: 'class', range: { start: { line: 1, column: 1 }, end: { line: 1, column: 14 } }, selectionRange: { start: { line: 1, column: 7 }, end: { line: 1, column: 11 } } }] };
  });
  try {
    const result = await fixture.providers.get('java:DocumentSymbol').provideDocumentSymbols(fixture.model);
    assert.equal(result[0].name, 'Main');
    assert.equal(result[0].kind, 4);
    assert.equal(result[0].selectionRange.startColumn, 7);
    assert.equal(calls[0].input.content, 'class Main {}');
    assert.equal(calls.length, 1);
  } finally { fixture.installed.dispose(); }
});

test('fast Java outline is discarded when the buffer changes during parsing', async () => {
  const fixture = providerFixture(async () => { fixture.edit(); return { items: [{ name: 'Old' }] }; });
  try { assert.deepEqual(await fixture.providers.get('java:DocumentSymbol').provideDocumentSymbols(fixture.model), []); }
  finally { fixture.installed.dispose(); }
});

test('fast Java outline preserves nested types, fields, constructors and UTF-16 positions', async () => {
  const item = (name, kind, start, end, column = 3) => ({ name, kind, range: { start: { line: start, column: 1 }, end: { line: end, column: 40 } }, selectionRange: { start: { line: start, column }, end: { line: start, column: column + name.length } } });
  const fixture = providerFixture(async () => ({ items: [item('after', 'field', 9, 9), item('Inner', 'class', 4, 8), item('Top', 'class', 1, 10), item('方法', 'method', 6, 7, 12), item('Top', 'constructor', 2, 3), item('broken', 'method', -1, 3)] }));
  try {
    const result = await fixture.providers.get('java:DocumentSymbol').provideDocumentSymbols(fixture.model);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].children.map(symbol => symbol.name), ['Top', 'Inner', 'after']);
    assert.equal(result[0].children[0].kind, 8);
    const method = result[0].children[1].children[0];
    assert.equal(method.name, '方法'); assert.equal(method.selectionRange.startLineNumber, 6); assert.equal(method.selectionRange.startColumn, 12);
    assert.equal(result[0].children[2].kind, 7);
  } finally { fixture.installed.dispose(); }
});

test('readonly Java dependency outline keeps using the project-bound semantic source', async () => {
  const fixture = providerFixture(async operation => {
    assert.equal(operation, 'document-symbols');
    return { result: [{ name: 'String', kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } }] };
  });
  fixture.model.uri.path = '/@java-source/aaaaaaaaaaaaaaaaaaaaaaaa/String.java';
  try { assert.equal((await fixture.providers.get('java:DocumentSymbol').provideDocumentSymbols(fixture.model))[0].name, 'String'); }
  finally { fixture.installed.dispose(); }
});

test('readonly JDK/JAR source caret movement skips workspace quick-fix requests', async () => {
  let calls = 0;
  const fixture = providerFixture(async () => { calls++; throw new Error('virtual path must not be sent to quick fixes'); });
  fixture.model.uri.path = '/@java-source/aaaaaaaaaaaaaaaaaaaaaaaa/String.java';
  try {
    const result = await fixture.providers.get('java:CodeAction').provideCodeActions(fixture.model, { startLineNumber: 1, startColumn: 1 }, { markers: [] });
    assert.deepEqual(result.actions, []);
    assert.equal(calls, 0);
  } finally { fixture.installed.dispose(); }
});

test('navigation providers prepare returned targets and normalize both Location and LocationLink', async () => {
  const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 12 } };
  const prepared = []; const calls = [];
  const fixture = providerFixture(async (operation, input) => { calls.push({ operation, input }); return { result: [{ path: 'Usage.java', targetSelectionRange: range }] }; }, async (locations) => prepared.push(locations));
  const result = await fixture.providers.get('java:Implementation').provideImplementation(fixture.model, { lineNumber: 3, column: 26 });
  assert.equal(result[0].uri.path, '/Usage.java'); assert.equal(result[0].range.startLineNumber, 3); assert.equal(result[0].range.startColumn, 5);
  assert.equal(prepared.length, 1); assert.equal(calls[0].operation, 'implementation'); assert.equal(calls[0].input.content, 'class Main {}');
  fixture.installed.dispose();
});
test('reference providers discard locations when the source changes during target loading or the workspace is disposed', async () => {
  for (const mutate of ['edit', 'disposeModel', 'disposeProviders']) {
    let release; let started; const begun = new Promise((resolve) => { started = resolve; });
    const fixture = providerFixture(async () => ({ result: [{ path: 'Usage.java', range: { start: { line: 2, character: 4 }, end: { line: 2, character: 12 } } }] }), async () => { started(); await new Promise((resolve) => { release = resolve; }); });
    const pending = fixture.providers.get('java:Reference').provideReferences(fixture.model, { lineNumber: 3, column: 26 });
    await begun; if (mutate === 'disposeProviders') fixture.installed.dispose(); else fixture[mutate](); release();
    assert.deepEqual(await pending, []); fixture.installed.dispose();
  }
});
test('providers do not request or preload references from another workspace', async () => {
  let calls = 0; const fixture = providerFixture(async () => { calls++; return { result: [] }; }, async () => { calls++; });
  fixture.model.uri.authority = 'foreign-session';
  assert.deepEqual(await fixture.providers.get('java:Reference').provideReferences(fixture.model, { lineNumber: 1, column: 1 }), []);
  assert.equal(calls, 0); fixture.installed.dispose();
});

test('rename prepares all changed files before returning edits and cancels without applying', async () => {
  const edit = { edits: [{ path: 'Other.java', edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'New' }] }] };
  for (const accepted of [true, false]) {
    let prepared = 0;
    const fixture = providerFixture(async () => ({ result: edit }), undefined, { prepareEdits: async (value) => { assert.deepEqual(value, edit); prepared++; return accepted; } });
    const result = await fixture.providers.get('java:Rename').provideRenameEdits(fixture.model, { lineNumber: 1, column: 1 }, 'New');
    assert.equal(prepared, 1); assert.equal(result.edits.length, accepted ? 1 : 0);
    fixture.installed.dispose();
  }
});

test('rename discards edits if the source changes while preparing targets', async () => {
  let fixture;
  fixture = providerFixture(async () => ({ result: { edits: [{ path: 'Other.java', edits: [] }] } }), undefined, { prepareEdits: async () => { fixture.edit(); return true; } });
  const result = await fixture.providers.get('java:Rename').provideRenameEdits(fixture.model, { lineNumber: 1, column: 1 }, 'New');
  assert.equal(result.edits.length, 0); assert.ok(result.rejectReason); fixture.installed.dispose();
});

test('language service failures are surfaced instead of being confused with empty navigation results', async () => {
  const errors = []; const error = new Error('service unavailable');
  const fixture = providerFixture(async () => { throw error; }, undefined, { onError: (value) => errors.push(value) });
  await assert.rejects(fixture.providers.get('java:Definition').provideDefinition(fixture.model, { lineNumber: 1, column: 1 }), /service unavailable/);
  assert.deepEqual(errors, [error]); fixture.installed.dispose();
});
