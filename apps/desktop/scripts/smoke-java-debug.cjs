const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const crypto = require('node:crypto');
const { createLocalApi } = require('../src/local-api.cjs');
const assert = require('node:assert/strict');
const { DapConnection } = require('../src/local-java-runtime.cjs');
const emittedStops = []; const originalEmit = DapConnection.prototype.emit;
DapConnection.prototype.emit = function(name, ...args) { if (name === 'stopped') emittedStops.push(args[0]); return originalEmit.call(this, name, ...args); };
let api; let window; let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-debug-ui-'));
fs.mkdirSync(path.join(directory, 'electron')); app.setPath('userData', path.join(directory, 'electron'));
// Keep Electron alive until asynchronous cleanup and the explicit result exit.
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Java debug UI smoke timed out'); app.exit(1); }, 180_000);
async function waitFor(expression) {
  for (let index = 0; index < 300; index++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`UI condition not reached: ${expression}`);
}
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const root = path.join(directory, 'Java UI');
    fs.mkdirSync(path.join(root, 'src/main/java'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pom.xml'), '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>sample</groupId><artifactId>java-ui</artifactId><version>1</version><properties><maven.compiler.release>17</maven.compiler.release></properties></project>');
    fs.writeFileSync(path.join(root, 'src/main/java/Main.java'), 'public class Main {\n  public static void main(String[] args) throws Exception {\n    int answer = 42;\n    System.out.println(answer + ":" + args[0] + ":" + System.getProperty("codeStudioSmoke"));\n    Thread.sleep(30000);\n  }\n}\n');
    fs.writeFileSync(path.join(root, 'src/main/java/Other.java'), 'class Other {\n  static String value() {\n    return "ok";\n  }\n}\n');
    // Isolated test encryption: exercises persistence without touching user Keychain.
    const key = crypto.randomBytes(32);
    const credentialCodec = { available: () => true, encrypt(value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); }, decrypt(value) { const data = Buffer.from(value, 'base64'); const cipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(); } };
    const createApi = () => createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3'), lspDataRoot: path.join(directory, 'language'), credentialCodec });
    api = await createApi(); const project = api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    window.webContents.on('console-message', (_event, _level, message) => { if (/uncaught|error/i.test(message)) console.error(message); });
    await window.loadURL(api.origin); await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Java UI')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Java UI').closest('button').click()`);
    await waitFor(`!!document.querySelector('button[title="Debug"]:not(:disabled)')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="运行参数"]').click()`);
    await waitFor(`!!document.querySelector('[data-java-run-modal] input[aria-label="程序参数"]')`);
    await window.webContents.executeJavaScript(`(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; for (const [placeholder, value] of [['--spring.profiles.active=dev', 'hello'], ['-Xmx1g -Dkey=value', '-DcodeStudioSmoke=verified']]) { const input = document.querySelector('input[placeholder="' + placeholder + '"]'); setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent === '保存运行配置').click()`);
    await waitFor(`document.body.textContent.includes('运行配置已保存到本机')`);
    await window.loadURL('about:blank'); await api.close(); api = await createApi();
    await window.loadURL(api.origin); await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Java UI')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Java UI').closest('button').click()`);
    await waitFor(`!!document.querySelector('button[title="Debug"]:not(:disabled)')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="运行参数"]').click()`);
    await waitFor(`document.querySelector('input[placeholder="--spring.profiles.active=dev"]')?.value === 'hello' && document.querySelector('input[placeholder="-Xmx1g -Dkey=value"]')?.value === '-DcodeStudioSmoke=verified' && document.body.textContent.includes('已恢复本地运行配置')`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭运行配置"]').click()`);
    // Open folders through the real file tree.
    for (const folder of ['src', 'main', 'java']) {
      await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '${folder}')`);
      await window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === '${folder}'); if (button.getAttribute('aria-expanded') !== 'true') button.click(); })()`);
    }
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Main.java')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Main.java').click()`);
    await waitFor(`!!document.querySelector('.monaco-editor .view-lines') && !!document.querySelector('button[title="Debug"]:not(:disabled)')`);
    const point = await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')); editor.revealLineInCenter(4); const visible = editor.getScrolledVisiblePosition({ lineNumber: 4, column: 1 }); const rect = editor.getDomNode().getBoundingClientRect(); resolve({ x: Math.round(rect.left + 10), y: Math.round(rect.top + visible.top + visible.height / 2) }); }))`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await waitFor(`!!document.querySelector('.desktop-java-breakpoint')`);
    // Wait for the durable snapshot, then reload the actual renderer. Restoration
    // must recreate the gutter marker without another click before Debug starts.
    await waitFor(`fetch('/api/local/projects/${project.id}/java-run/breakpoint-configuration').then(response => response.json()).then(body => Object.values(body.breakpoints || {}).some(lines => lines.includes(4)))`);
    await window.webContents.reload();
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Java UI')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Java UI').closest('button').click()`);
    for (const folder of ['src', 'main', 'java']) {
      await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '${folder}')`);
      await window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === '${folder}'); if (button.getAttribute('aria-expanded') !== 'true') button.click(); })()`);
    }
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Main.java')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Main.java').click()`);
    await waitFor(`!!document.querySelector('.desktop-java-breakpoint') && !!document.querySelector('button[title="Debug"]:not(:disabled)')`);
    // Use actual Monaco edits, not synthetic React state. Dirty migration must
    // update the gutter but leave the durable disk-aligned snapshot untouched.
    async function editBreakpointSource(undo = false) {
      await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')); ${undo ? "editor.trigger('smoke', 'undo', null);" : "editor.pushUndoStop(); editor.executeEdits('smoke', [{ range: new monaco.Range(1, 1, 1, 1), text: '// migration smoke\\n' }]); editor.pushUndoStop();"} resolve(); }))`);
    }
    const storedLine = line => `fetch('/api/local/projects/${project.id}/java-run/breakpoint-configuration').then(response => response.json()).then(body => Object.values(body.breakpoints || {}).some(points => points.some(point => (typeof point === 'number' ? point : point.line) === ${line})))`;
    const visibleLine = line => `new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const model = monaco.editor.getModels().find(model => model.uri.path.endsWith('Main.java')); resolve(model?.getAllDecorations().some(decoration => decoration.options.glyphMarginClassName?.includes('desktop-java-breakpoint') && decoration.range.startLineNumber === ${line})); }))`;
    await editBreakpointSource(); await waitFor(visibleLine(5));
    assert.equal(await window.webContents.executeJavaScript(storedLine(4)), true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '保存').click()`);
    await waitFor(storedLine(5));
    assert.match(fs.readFileSync(path.join(root, 'src/main/java/Main.java'), 'utf8'), /^\/\/ migration smoke\n/);
    await editBreakpointSource(true); await waitFor(visibleLine(4));
    assert.equal(await window.webContents.executeJavaScript(storedLine(5)), true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '保存').click()`);
    await waitFor(storedLine(4));
    assert.match(fs.readFileSync(path.join(root, 'src/main/java/Main.java'), 'utf8'), /^public class Main/);
    console.log('Java breakpoint migration UI passed: real editor insertion/undo moves glyphs; dirty edits do not persist; saving commits disk-aligned breakpoint lines.');
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')); editor.pushUndoStop(); editor.executeEdits('smoke', [{ range: new monaco.Range(4, 1, 5, 1), text: '' }]); editor.pushUndoStop(); resolve(); }))`);
    await waitFor(`!document.querySelector('.desktop-java-breakpoint')`);
    await editBreakpointSource(true); await waitFor(visibleLine(4));
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')).trigger('smoke', 'redo', null); resolve(); }))`);
    await waitFor(`!document.querySelector('.desktop-java-breakpoint')`);
    await editBreakpointSource(true); await waitFor(visibleLine(4));
    assert.equal(await window.webContents.executeJavaScript(storedLine(4)), true);
    console.log('Java deleted-line undo UI passed: deleting the last point, undo, redo and undo restores the breakpoint with actual Monaco history.');
    async function activateFile(name) {
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('li > button')].find(node => node.textContent.trim() === ${JSON.stringify(name)}).click()`);
      await waitFor(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; resolve(monaco.editor.getEditors().some(editor => editor.getModel()?.uri.path.endsWith(${JSON.stringify('/' + name)}))); }))`);
    }
    async function closeDraft(path) {
      await window.webContents.executeJavaScript(`(() => { const original = window.confirm; window.confirm = () => true; document.querySelector('button[title="' + ${JSON.stringify(path)} + '"] [role="button"]').click(); window.confirm = original; })()`);
      await waitFor(`!document.querySelector('button[title="' + ${JSON.stringify(path)} + '"] [role="button"]')`);
    }
    await activateFile('Other.java');
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; monaco.editor.getModels().find(model => model.uri.path.endsWith('Other.java')).applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: '// discard other\\n' }]); resolve(); }))`);
    await activateFile('Main.java');
    await editBreakpointSource(); await waitFor(visibleLine(5));
    await window.webContents.executeJavaScript(`(() => { const original = window.fetch; window.__restoreCheckpointFetch = () => { window.fetch = original; }; let delayed = false; window.fetch = async (...args) => { const response = await original(...args); if (!delayed && String(args[0]).endsWith('/content') && args[1]?.method === 'PUT') { delayed = true; await new Promise(resolve => { window.__releaseCheckpointSave = resolve; }); } return response; }; })()`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '保存').click()`);
    await waitFor(`typeof window.__releaseCheckpointSave === 'function'`);
    await window.webContents.executeJavaScript(`(() => { const original = window.confirm; window.confirm = () => true; document.querySelector('button[title="src/main/java/Main.java"] [role="button"]').click(); window.confirm = original; })()`);
    assert.equal(await window.webContents.executeJavaScript(`!!document.querySelector('button[title="src/main/java/Main.java"] [role="button"]')`), true, 'in-flight source save must prevent draft discard');
    await window.webContents.executeJavaScript(`window.__releaseCheckpointSave(); window.__restoreCheckpointFetch()`);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '保存' && node.disabled)`);
    assert.equal(await window.webContents.executeJavaScript(storedLine(4)), true, 'other unsaved file keeps global breakpoint write deferred');
    await editBreakpointSource(); await waitFor(visibleLine(6));
    await closeDraft('src/main/java/Main.java');
    await closeDraft('src/main/java/Other.java');
    await waitFor(storedLine(5));
    assert.match(fs.readFileSync(path.join(root, 'src/main/java/Main.java'), 'utf8'), /^\/\/ migration smoke\npublic class Main/);
    assert.match(fs.readFileSync(path.join(root, 'src/main/java/Other.java'), 'utf8'), /^class Other/);
    await activateFile('Main.java'); await waitFor(visibleLine(5));
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')); editor.executeEdits('smoke', [{ range: new monaco.Range(1, 1, 2, 1), text: '' }]); resolve(); }))`);
    await waitFor(visibleLine(4));
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '保存').click()`);
    await waitFor(storedLine(4));
    console.log('Java discarded-draft UI passed: partial file save advances its disk checkpoint; later edit/discard restores the saved line, reopening matches disk and does not retain the discarded draft.');
    await window.webContents.executeJavaScript(`document.querySelector('button[title="Debug"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已暂停') && document.body.textContent.includes('answer: 42')`);
    await waitFor(`!!document.querySelector('.desktop-java-current-line')`);
    async function evaluateExpression(expression) {
      await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="调试表达式"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(expression)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await window.webContents.executeJavaScript(`document.querySelector('input[aria-label="调试表达式"]').closest('form').querySelector('button').click()`);
    }
    await evaluateExpression('answer + 1');
    await waitFor(`document.querySelector('[data-debug-evaluation-result]')?.textContent.includes('answer + 1: 43')`);
    await evaluateExpression('args');
    await waitFor(`!!document.querySelector('[data-debug-evaluation-result] button')`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-debug-evaluation-result] button').click()`);
    await waitFor(`document.querySelector('[data-debug-evaluation-result]')?.textContent.includes('hello')`);
    await evaluateExpression('doesNotExist + 1');
    await waitFor(`!!document.querySelector('input[aria-label="调试表达式"]').closest('div').parentElement.querySelector('[role="alert"]')`);
    // Delay one real HTTP response while rapidly changing two gutter points.
    // The last snapshot must still reach DAP when the first request finishes.
    await window.webContents.executeJavaScript(`(() => { const original = window.fetch; window.__restoreBreakpointFetch = () => { window.fetch = original; }; let delayed = false; window.fetch = async (...args) => { const response = await original(...args); if (String(args[0]).endsWith('/java-run/breakpoints') && !delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 500)); } return response; }; })()`);
    for (const line of [4, 5]) {
      const gutter = await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')); editor.revealLineInCenter(${line}); const visible = editor.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }); const rect = editor.getDomNode().getBoundingClientRect(); resolve({ x: Math.round(rect.left + 10), y: Math.round(rect.top + visible.top + visible.height / 2) }); }))`);
      window.webContents.sendInputEvent({ type: 'mouseDown', ...gutter, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...gutter, button: 'left', clickCount: 1 });
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    await waitFor(`fetch('/api/local/projects/${project.id}/java-run').then(response => response.json()).then(body => body.breakpoints?.length === 1 && body.breakpoints[0].line === 5 && body.breakpoints[0].verified)`);
    await window.webContents.executeJavaScript(`window.__restoreBreakpointFetch()`);
    console.log('Java breakpoint sync UI passed: delayed response plus rapid gutter updates reaches the latest DAP snapshot.');
    await window.webContents.executeJavaScript(`document.querySelector('button[title="单步跳过"]').click()`);
    await waitFor(`document.body.textContent.includes('main(String[]):5') && document.body.textContent.includes('answer: 42')`);
    await waitFor(`!document.querySelector('[data-debug-evaluation-result]') && document.querySelector('input[aria-label="调试表达式"]')?.value === ''`);
    await waitFor(`document.body.textContent.includes('42:hello:verified')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="停止"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已结束')`);
    // Exercise an actual compile failure, then navigate from the Problems list.
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const model = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')).getModel(); model.setValue(model.getValue().replace('answer = 42', 'answer = missing()')); resolve(); }))`);
    await waitFor(`!!document.querySelector('button[title="src/main/java/Main.java"] .rounded-full')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存').click()`);
    await waitFor(`!document.querySelector('button[title="src/main/java/Main.java"] .rounded-full')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="Debug"]').click()`);
    await waitFor(`document.body.textContent.includes('编译问题（1）') && document.body.textContent.includes('missing')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'pom.xml').click()`);
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('xmlns')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('src/main/java/Main.java:3') && button.textContent.includes('missing')).click()`);
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('missing')`);
    console.log('Java debug UI smoke passed: persisted/reloaded gutter breakpoint, Debug button, current line, variables, step and stop.');
    console.log('Java build errors UI smoke passed: real compile failure, file/line details and source navigation.');
    await window.webContents.executeJavaScript(`(() => { if (![...document.querySelectorAll('button')].some(node => node.textContent === '清除保存配置')) document.querySelector('button[title="运行参数"]').click(); })()`);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent === '清除保存配置')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent === '清除保存配置').click()`);
    await waitFor(`document.querySelector('input[placeholder="--spring.profiles.active=dev"]')?.value === '' && document.body.textContent.includes('已清除保存的运行配置')`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭运行配置"]').click()`);
    console.log('Java configuration UI smoke passed: save, Local API restart, restore, actual program/JVM arguments and clear.');
    console.log('Java evaluation UI smoke passed: primitive expression, object expansion, compile error and pause-change reset.');
    async function gutterClick(line, button = 'left') {
      const point = await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')); editor.revealLineInCenter(${line}); const visible = editor.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }); const rect = editor.getDomNode().getBoundingClientRect(); resolve({ x: Math.round(rect.left + 10), y: Math.round(rect.top + visible.top + visible.height / 2) }); }))`);
      window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button, clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button, clickCount: 1 });
    }
    async function editCondition(expression, hit = '', log = '') {
      await gutterClick(4, 'right');
      await waitFor(`!!document.querySelector('input[aria-label="断点条件"]')`);
      await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="断点条件"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(expression)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      for (const [label, value] of [['断点命中次数', hit], ['断点日志消息', log]]) await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await window.webContents.executeJavaScript(`document.querySelector('form[aria-label="断点条件设置"] button').click()`);
      await waitFor(`!document.querySelector('input[aria-label="断点条件"]')`);
    }
    await gutterClick(5); // Remove the earlier ordinary breakpoint.
    await waitFor(`!document.querySelector('.desktop-java-breakpoint')`);
    const loop = 'public class Main {\n  public static void main(String[] args) {\n    for (int i = 0; i < 4; i++) {\n      System.out.println("condition:" + i);\n    }\n  }\n}\n';
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')).getModel().setValue(${JSON.stringify(loop)}); resolve(); }))`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存').click()`);
    await waitFor(`!document.querySelector('button[title="src/main/java/Main.java"] .rounded-full')`);
    await editCondition('i == 2');
    await waitFor(`fetch('/api/local/projects/${project.id}/java-run/breakpoint-configuration').then(response => response.json()).then(body => body.breakpoints?.['src/main/java/Main.java']?.[0]?.condition === 'i == 2')`);
    window.webContents.reload();
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Java UI')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Java UI').closest('button').click()`);
    for (const folder of ['src', 'main', 'java']) {
      await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '${folder}')`);
      await window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === '${folder}'); if (button.getAttribute('aria-expanded') !== 'true') button.click(); })()`);
    }
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Main.java').click()`);
    await waitFor(`!!document.querySelector('.desktop-java-breakpoint-conditional') && !!document.querySelector('button[title="Debug"]:not(:disabled)')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="Debug"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已暂停') && document.body.textContent.includes('i: 2')`);
    await waitFor(`document.body.textContent.includes('condition:0') && document.body.textContent.includes('condition:1')`);
    await editCondition('i == 3');
    await waitFor(`fetch('/api/local/projects/${project.id}/java-run').then(response => response.json()).then(body => body.breakpoints?.[0]?.condition === 'i == 3' && body.breakpoints[0].verified)`);
    await waitFor(`!!document.querySelector('button[title="继续"]:not(:disabled)')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="继续"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已暂停') && document.body.textContent.includes('i: 3')`);
    await editCondition('');
    await waitFor(`fetch('/api/local/projects/${project.id}/java-run').then(response => response.json()).then(body => body.breakpoints?.[0]?.line === 4 && !body.breakpoints[0].condition && body.breakpoints[0].verified)`);
    await waitFor(`!document.querySelector('.desktop-java-breakpoint-conditional') && !!document.querySelector('.desktop-java-breakpoint')`);
    await waitFor(`!!document.querySelector('button[title="停止"]:not(:disabled)')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="停止"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已结束')`);
    console.log('Java conditional breakpoint UI passed: right-click editing, encrypted restore, false conditions skipped, true condition stops at i=2, dynamic edit stops at i=3, clear condition restores ordinary breakpoint.');
    await editCondition('', '3');
    emittedStops.length = 0;
    await window.webContents.executeJavaScript(`document.querySelector('button[title="Debug"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已暂停') && document.body.textContent.includes('i: 2')`);
    assert.equal(emittedStops.length, 1, 'hit count 3 must skip the first two hits');
    await waitFor(`!!document.querySelector('button[title="继续"]:not(:disabled)')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="继续"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已结束')`);
    assert.equal(emittedStops.length, 1, 'positive hit count is a single Nth-hit stop');
    await editCondition('', '', 'trace:{i}');
    await waitFor(`fetch('/api/local/projects/${project.id}/java-run/breakpoint-configuration').then(response => response.json()).then(body => body.breakpoints?.['src/main/java/Main.java']?.[0]?.logMessage === 'trace:{i}')`);
    window.webContents.reload();
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Java UI')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Java UI').closest('button').click()`);
    for (const folder of ['src', 'main', 'java']) {
      await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '${folder}')`);
      await window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === '${folder}'); if (button.getAttribute('aria-expanded') !== 'true') button.click(); })()`);
    }
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Main.java').click()`);
    await waitFor(`!!document.querySelector('.desktop-java-logpoint') && !!document.querySelector('button[title="Debug"]:not(:disabled)')`);
    emittedStops.length = 0;
    await window.webContents.executeJavaScript(`document.querySelector('button[title="Debug"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已结束') && [0,1,2,3].every(i => document.body.textContent.includes('trace:' + i))`);
    assert.equal(emittedStops.length, 0, 'logpoints must never emit a stopped event');
    console.log('Java hit-count/logpoint UI passed: third-hit stop only, four interpolated logs, zero stopped events, right-click editing and persisted logpoint reload.');
    // Named profiles share the existing encrypted configuration storage and
    // actual Run pathway; switching must restore both program and JVM args.
    await window.webContents.executeJavaScript(`document.querySelector('button[title="运行参数"]').click()`);
    await waitFor(`!!document.querySelector('input[aria-label="运行配置名称"]')`);
    async function saveNamedProfile(name, argument, property) {
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '新建配置').click()`);
      await window.webContents.executeJavaScript(`(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; for (const [selector, value] of [['input[aria-label="运行配置名称"]', ${JSON.stringify(name)}], ['input[placeholder="--spring.profiles.active=dev"]', ${JSON.stringify(argument)}], ['input[placeholder="-Xmx1g -Dkey=value"]', ${JSON.stringify('-DcodeStudioProfile=' + property)}]]) { const input = document.querySelector(selector); setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存运行配置').click()`);
      await waitFor(`document.body.textContent.includes('运行配置已保存到本机') && document.querySelector('button[aria-label="已保存运行配置"]')?.textContent.includes(${JSON.stringify(name)})`);
    }
    await saveNamedProfile('开发配置', 'dev', 'dev'); await saveNamedProfile('生产配置', 'prod', 'prod');
    const named = await window.webContents.executeJavaScript(`fetch('/api/local/projects/${project.id}/java-run/configurations').then(response => response.json())`);
    assert.equal(named.configurations.length, 2);
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="已保存运行配置"]').click()`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('[role="option"]')].find(option => option.textContent.includes('开发配置')).click()`);
    await waitFor(`document.querySelector('input[placeholder="--spring.profiles.active=dev"]')?.value === 'dev' && document.querySelector('input[placeholder="-Xmx1g -Dkey=value"]')?.value === '-DcodeStudioProfile=dev'`);
    await window.webContents.reload();
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Java UI')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Java UI').closest('button').click()`);
    await waitFor(`!!document.querySelector('button[title="Debug"]:not(:disabled)')`);
    for (const folder of ['src', 'main', 'java']) await window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('li > button')].find(node => node.textContent.trim() === '${folder}'); if (button?.getAttribute('aria-expanded') !== 'true') button?.click(); })()`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('li > button')].find(node => node.textContent.trim() === 'Main.java').click()`);
    await waitFor(`!!document.querySelector('.desktop-java-logpoint')`);
    const loopSource = fs.readFileSync(path.join(root, 'src/main/java/Main.java'), 'utf8');
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')).getModel().setValue('public class Main { public static void main(String[] args) { System.out.println("profile=" + args[0] + ":" + System.getProperty("codeStudioProfile")); } }'); resolve(); }))`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '保存' && !button.disabled)`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存').click()`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '保存' && button.disabled)`);
    await waitFor(`!document.querySelector('button[title="src/main/java/Main.java"] .rounded-full')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="运行"]').click()`);
    await waitFor(`document.body.textContent.includes('profile=dev:dev') && document.body.textContent.includes('运行 · 已结束')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="运行参数"]').click()`);
    await waitFor(`document.querySelector('button[aria-label="已保存运行配置"]')?.textContent.includes('开发配置')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '清除保存配置').click()`);
    await waitFor(`document.querySelector('input[placeholder="--spring.profiles.active=dev"]')?.value === 'prod' && document.querySelector('button[aria-label="已保存运行配置"]')?.textContent.includes('生产配置')`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭运行配置"]').click()`);
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')).getModel().setValue(${JSON.stringify(loopSource)}); resolve(); }))`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '保存' && !button.disabled)`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存').click()`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '保存' && button.disabled)`);
    console.log('Java named profiles UI passed: create two configurations, custom dropdown switch, renderer reload restores selected profile, actual Run prints dev program/JVM args, deleting it retains and selects production.');
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('li > button')].find(node => node.textContent.trim() === 'Other.java').click()`);
    await waitFor(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; resolve(monaco.editor.getEditors().some(editor => editor.getModel()?.uri.path.endsWith('Other.java'))); }))`);
    const otherPoint = await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Other.java')); const visible = editor.getScrolledVisiblePosition({ lineNumber: 2, column: 1 }); const rect = editor.getDomNode().getBoundingClientRect(); resolve({ x: Math.round(rect.left + 10), y: Math.round(rect.top + visible.top + visible.height / 2) }); }))`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...otherPoint, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...otherPoint, button: 'left', clickCount: 1 });
    const otherStored = line => `fetch('/api/local/projects/${project.id}/java-run/breakpoint-configuration').then(response => response.json()).then(body => body.breakpoints?.['src/main/java/Other.java']?.includes(${line}))`;
    await waitFor(otherStored(2));
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('li > button')].find(node => node.textContent.trim() === 'Main.java').click()`);
    await waitFor(`!!document.querySelector('.desktop-java-logpoint')`);
    await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const model = monaco.editor.getModels().find(model => model.uri.path.endsWith('Other.java')); model.pushStackElement(); model.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: '// inactive refactor\\n' }]); model.pushStackElement(); resolve(); }))`);
    assert.equal(await window.webContents.executeJavaScript(otherStored(2)), true);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '全部保存' && !node.disabled)`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '全部保存').click()`);
    await waitFor(otherStored(3));
    console.log('Java inactive-document migration UI passed: editing a non-active project model updates its draft and breakpoint; Save All persists the moved line without switching tabs.');
    async function moveInTree(name, destination) {
      await window.webContents.executeJavaScript(`(() => { const row = [...document.querySelectorAll('li > button')].find(node => node.textContent.trim() === ${JSON.stringify(name)}); if (!row) throw new Error('Missing file tree row'); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: row.getBoundingClientRect().left + 20 })); })()`);
      await waitFor(`!!document.querySelector('[role="menu"]')`);
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('[role="menu"] button')].find(node => node.textContent.includes('重命名 / 移动')).click()`);
      await waitFor(`!!document.querySelector('[role="dialog"] input')`);
      await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('[role="dialog"] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(destination)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent.trim() === '确认').click()`);
      await waitFor(`fetch('/api/local/projects/${project.id}/java-run/breakpoint-configuration').then(response => response.json()).then(body => body.breakpoints?.[${JSON.stringify(destination.endsWith('.java') ? destination : destination + '/Main.java')}]?.[0]?.logMessage === 'trace:{i}')`);
      await waitFor(`!!document.querySelector('.desktop-java-logpoint')`);
      if (destination.endsWith('.java')) await waitFor(`[...document.querySelectorAll('li > button')].some(button => button.title === ${JSON.stringify(destination)})`);
    }
    await moveInTree('Main.java', 'Main.java');
    assert.equal(fs.existsSync(path.join(root, 'Main.java')), true);
    await moveInTree('Main.java', 'src/main/java/Main.java');
    assert.equal(fs.existsSync(path.join(root, 'src/main/java/Main.java')), true);
    await moveInTree('java', 'src/main/java-renamed');
    assert.equal(fs.existsSync(path.join(root, 'src/main/java-renamed/Main.java')), true);
    console.log('Java file move UI passed: right-click file move/back and directory rename update open models and persist the advanced logpoint path.');
  } catch (error) { console.error(error); if (window) console.error('Isolated Java UI diagnostics:', await window.webContents.executeJavaScript('document.body.innerText.slice(-5000)').catch(() => 'window unavailable')); exitCode = 1; }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(exitCode); }
});
