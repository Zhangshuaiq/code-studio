const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../web/src/lib/workspace-relations.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
test('shared editor project navigation discloses scope, opens target, and ignores stale responses', async () => {
  const exports = {};
  const element = () => ({ children: [], append(child) { this.children.push(child); this.firstChild ||= child; }, setAttribute() {}, focus() {} });
  vm.runInNewContext(source, { exports, require: () => ({ workspacePathFromUri: () => 'Api.java' }), document: { createElement: element, visibilityState: 'hidden' }, setTimeout, clearTimeout, setInterval, clearInterval });
  let version = 1, widget, action, requestInput, release;
  const model = { uri: { toString: () => 'workspace://project/Api.java' }, getVersionId: () => version, getValue: () => 'interface Api { void run(); }', isDisposed: () => false };
  const listener = () => ({ dispose() {} });
  const editor = { getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 22 }), getDomNode: () => null,
    createDecorationsCollection: () => ({ clear() {}, set() {} }), updateOptions() {},
    onDidChangeModel: listener, onDidChangeModelContent: listener, onDidFocusEditorText: listener, onMouseDown: listener, onDidDispose() {},
    addAction(value) { action = value; return { dispose() {} }; }, addOverlayWidget(value) { widget = value; }, removeOverlayWidget() { widget = undefined; } };
  const opened = [];
  const installed = exports.installWorkspaceRelations(editor, { editor: { OverlayWidgetPositionPreference: { TOP_CENTER: 1 } } }, {
    request: async input => { requestInput = input; if (release === null) await new Promise(resolve => { release = resolve; }); return { result: { rows: [{ links: [{ path: 'Impl.java', line: 4, column: 12, direction: 'down', label: 'p.Impl.run' }] }] } }; },
    open: (...args) => opened.push(args),
  });
  try {
    await action.run();
    assert.equal(requestInput.line, 1); assert.equal(requestInput.column, 22);
    assert.match(widget.getDomNode().firstChild.textContent, /项目内声明匹配/);
    widget.getDomNode().children[1].onclick();
    assert.deepEqual(opened, [['Impl.java', 4, 12]]);
    release = null;
    const pending = action.run();
    version++;
    release(); await pending;
    assert.equal(widget, undefined);
  } finally { installed.dispose(); }
});
