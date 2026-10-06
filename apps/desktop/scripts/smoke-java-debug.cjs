const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { createLocalApi } = require('../src/local-api.cjs');
let api; let window; let directory;
const deadline = setTimeout(() => { console.error('Java debug UI smoke timed out'); app.exit(1); }, 120_000);
async function waitFor(expression) {
  for (let index = 0; index < 300; index++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`UI condition not reached: ${expression}`);
}
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-debug-ui-')); const root = path.join(directory, 'Java UI');
    fs.mkdirSync(path.join(root, 'src/main/java'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pom.xml'), '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>sample</groupId><artifactId>java-ui</artifactId><version>1</version><properties><maven.compiler.release>17</maven.compiler.release></properties></project>');
    fs.writeFileSync(path.join(root, 'src/main/java/Main.java'), 'public class Main {\n  public static void main(String[] args) throws Exception {\n    int answer = 42;\n    System.out.println(answer);\n    Thread.sleep(30000);\n  }\n}\n');
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3'), lspDataRoot: path.join(directory, 'language') }); api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    window.webContents.on('console-message', (_event, _level, message) => { if (/uncaught|error/i.test(message)) console.error(message); });
    await window.loadURL(api.origin); await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Java UI')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Java UI').closest('button').click()`);
    // Open folders through the real file tree.
    for (const folder of ['src', 'main', 'java']) {
      await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '${folder}')`);
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '${folder}').click()`);
    }
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Main.java')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Main.java').click()`);
    await waitFor(`!!document.querySelector('.monaco-editor .view-lines') && !!document.querySelector('button[title="Debug"]:not(:disabled)')`);
    const point = await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], editorModule => { const monaco = window.monaco || editorModule; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Main.java')); editor.revealLineInCenter(4); const visible = editor.getScrolledVisiblePosition({ lineNumber: 4, column: 1 }); const rect = editor.getDomNode().getBoundingClientRect(); resolve({ x: Math.round(rect.left + 10), y: Math.round(rect.top + visible.top + visible.height / 2) }); }))`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await waitFor(`!!document.querySelector('.desktop-java-breakpoint')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="Debug"]').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已暂停') && document.body.textContent.includes('answer: 42')`);
    await waitFor(`!!document.querySelector('.desktop-java-current-line')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="单步跳过"]').click()`);
    await waitFor(`document.body.textContent.includes('main(String[]):5') && document.body.textContent.includes('answer: 42')`);
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
    console.log('Java debug UI smoke passed: gutter breakpoint, Debug button, current line, variables, step and stop.');
    console.log('Java build errors UI smoke passed: real compile failure, file/line details and source navigation.');
  } catch (error) { console.error(error); exitCode = 1; }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(exitCode); }
});
