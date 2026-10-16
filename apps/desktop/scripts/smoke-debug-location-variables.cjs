const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { createLocalApi } = require('../src/local-api.cjs');
let api; let window; let directory;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Debug location / variables smoke timed out'); app.exit(1); }, 180_000);
async function waitFor(expression) {
  for (let index = 0; index < 800; index++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`UI condition not reached: ${expression}`);
}
const withEditor = (expression) => `new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const editor = monaco.editor.getEditors().find(editor => editor.getDomNode()?.isConnected); resolve(editor ? (${expression}) : false); }))`;
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-location-ui-')); const root = path.join(directory, 'Debug location');
    fs.mkdirSync(path.join(root, 'src/main/java'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pom.xml'), '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>sample</groupId><artifactId>debug-location</artifactId><version>1</version><properties><maven.compiler.release>17</maven.compiler.release></properties></project>');
    const source = 'public class Main {\n static class Box { int value = 40; public String toString() { return "Box(" + value + ")"; } }\n public static void main(String[] args) throws Exception {\n  Box box = new Box();\n' + '\n'.repeat(100) + '  for (int index = 0; index < 2; index++) {\n   box.value++;\n   System.out.println(box.value);\n  }\n  Thread.sleep(30000);\n }\n}\n';
    const line = source.split('\n').findIndex((text) => text.includes('System.out.println')) + 1;
    fs.writeFileSync(path.join(root, 'src/main/java/Runner.java'), 'public interface Runner { void run(); }\n');
    fs.writeFileSync(path.join(root, 'src/main/java/Main.java'), source.replace('public class Main {', 'public class Main implements Runner {').replace(/\n}\n$/, '\n public void run() {}\n}\n'));
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3'), lspDataRoot: path.join(directory, 'language'), credentialCodec: { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() } }); api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(api.origin);
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Debug location')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Debug location').closest('button').click()`);
    for (const folder of ['src', 'main', 'java']) { await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '${folder}')`); await window.webContents.executeJavaScript(`(() => { const node = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === '${folder}'); if(node.getAttribute('aria-expanded') !== 'true') node.click(); })()`); }
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Main.java')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Main.java').click()`);
    await waitFor(`!!document.querySelector('.monaco-editor .view-lines')`);
    await waitFor(withEditor(`editor.getModel()?.uri.path.endsWith('Main.java')`));
    await window.webContents.executeJavaScript(withEditor(`(editor.revealLineInCenter(${line}), true)`));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const point = await window.webContents.executeJavaScript(withEditor(`(() => { const position = editor.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }); const rect = editor.getDomNode().getBoundingClientRect(); const layout = editor.getLayoutInfo(); return { x: Math.round(rect.left + layout.glyphMarginLeft + layout.glyphMarginWidth - 5), y: Math.round(rect.top + position.top + position.height / 2) }; })()`));
    await window.webContents.executeJavaScript(withEditor(`(editor.onMouseDown(event => { window.__lastGutter = {type:event.target.type,detail:event.target.detail,position:event.target.position,button:event.event.browserEvent.button}; }), true)`));
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await waitFor(`!!document.querySelector('.desktop-java-breakpoint')`);
    const dot = await window.webContents.executeJavaScript(`(() => { const node = document.querySelector('.desktop-java-breakpoint'); const style = getComputedStyle(node, '::after'); return { color: style.backgroundColor, width: style.width, height: style.height, visible: node.getBoundingClientRect().width > 0 }; })()`);
    assert.deepEqual(dot, { color:'rgb(239, 68, 68)', width:'8px', height:'8px', visible:true });
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'pom.xml').click()`);
    await waitFor(withEditor(`editor.getModel()?.uri.path.endsWith('pom.xml')`));
    await waitFor(`!!document.querySelector('button[title="Debug"]:not(:disabled)')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="Debug"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已暂停') && document.body.textContent.includes('box: ')`);
    await waitFor(withEditor(`editor.getModel()?.uri.path.endsWith('Main.java') && editor.getPosition()?.lineNumber === ${line}`));
    await waitFor(`!!document.querySelector('.desktop-java-execution-pointer') && !!document.querySelector('.workspace-relation-arrow')`);
    const lanes = await window.webContents.executeJavaScript(`(() => { const breakpoint = document.querySelector('.desktop-java-breakpoint').getBoundingClientRect(), pointer = document.querySelector('.desktop-java-execution-pointer').getBoundingClientRect(); return { breakpointRight: breakpoint.right, executionLeft: pointer.left }; })()`);
    assert.ok(lanes.breakpointRight <= lanes.executionLeft + 1, 'breakpoint and execution must occupy separate lanes');
    const positionVisible = await window.webContents.executeJavaScript(withEditor(`(() => { const position = editor.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }); return position && position.top >= 0 && position.top + position.height <= editor.getLayoutInfo().height; })()`));
    assert.equal(positionVisible, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.includes('box: ')).click()`);
    await waitFor(`document.body.textContent.includes('value: 41')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="继续"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已暂停') && document.body.textContent.includes('Box(42)')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.includes('box: ')).click()`);
    await waitFor(`document.body.textContent.includes('value: 42')`);
    // Move away manually, leave the project, and return to the same paused frame.
    await window.webContents.executeJavaScript(withEditor(`(editor.setPosition({ lineNumber: 1, column: 1 }), editor.revealLine(1), true)`));
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('aside button')].find(node => node.textContent.trim() === '数据源').click()`);
    await waitFor(`document.querySelector('.workspace-frame')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'true'`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('main button')].find(node => node.textContent.trim() === 'Debug location').click()`);
    await waitFor(withEditor(`editor.getPosition()?.lineNumber === ${line}`));
    await window.webContents.executeJavaScript(`document.querySelector('button[title="停止"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已结束')`);
    console.log('Debug location / variables smoke passed: cross-file cursor + viewport, object fields, same-line repeated breakpoint values 41 -> 42, tab return relocation.');
  } catch (error) { console.error(error); if(window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript(withEditor(`({ click:window.__lastGutter, layout:editor.getLayoutInfo(), glyphMargin:editor.getOption(monaco.editor.EditorOption.glyphMargin), path:editor.getModel()?.uri.path, visible:document.body.innerText.slice(-500), breakpoints:document.querySelectorAll('.desktop-java-breakpoint').length })`)).catch(()=>'')); exitCode = 1; }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(exitCode); }
});
