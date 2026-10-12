const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const assert = require('node:assert/strict'); const crypto = require('node:crypto');
const { createLocalApi } = require('../src/local-api.cjs');
app.on('window-all-closed', () => {});
let api; let window; let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-threads-ui-'));
fs.mkdirSync(path.join(directory, 'electron')); app.setPath('userData', path.join(directory, 'electron'));
async function waitFor(expression) {
  for (let i = 0; i < 300; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Not reached: ${expression}`);
}
app.whenReady().then(async () => {
  let exitCode = 0; const deadline = setTimeout(() => app.exit(1), 150000);
  try {
    const root = path.join(directory, 'Threads UI'); fs.mkdirSync(path.join(root, 'src/main/java'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pom.xml'), '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>sample</groupId><artifactId>threads-ui</artifactId><version>1</version><properties><maven.compiler.release>17</maven.compiler.release></properties></project>');
    fs.writeFileSync(path.join(root, 'src/main/java/Main.java'), 'public class Main {\n  public static void main(String[] args) throws Exception {\n    int mainValue = 42;\n    Worker worker = new Worker();\n    worker.start();\n    while (!Worker.ready) Thread.sleep(10);\n    System.out.println(mainValue);\n    worker.join();\n  }\n}\n');
    fs.writeFileSync(path.join(root, 'src/main/java/Worker.java'), 'class Worker extends Thread {\n  static volatile boolean ready;\n  Worker() { super("code-studio-worker"); }\n  public void run() {\n    int workerValue = 73;\n    ready = true;\n    System.out.println(workerValue);\n  }\n}\n');
    const key = crypto.randomBytes(32);
    const codec = { available: () => true, encrypt(value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); }, decrypt(value) { const data = Buffer.from(value, 'base64'); const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(); } };
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3'), lspDataRoot: path.join(directory, 'language'), credentialCodec: codec }); const project = api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(api.origin); await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Threads UI')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Threads UI').closest('button').click()`);
    await waitFor(`!!document.querySelector('button[title="Debug"]:not(:disabled)')`);
    for (const folder of ['src', 'main', 'java']) await window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('li > button')].find(node => node.textContent.trim() === '${folder}'); if (button?.getAttribute('aria-expanded') !== 'true') button?.click(); })()`);
    await window.webContents.executeJavaScript(`document.querySelector('li > button[title="src/main/java/Worker.java"]').click()`);
    await waitFor(`typeof window.require === 'function' && !!document.querySelector('.monaco-editor .view-lines')`);
    const point = await window.webContents.executeJavaScript(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { const monaco = window.monaco || module; const editor = monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith('Worker.java')); const position = editor.getScrolledVisiblePosition({ lineNumber: 6, column: 1 }); const rect = editor.getDomNode().getBoundingClientRect(); resolve({ x: Math.round(rect.left + 10), y: Math.round(rect.top + position.top + position.height / 2) }); }))`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await waitFor(`!!document.querySelector('.desktop-java-breakpoint')`);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="Debug"]').click()`);
    await waitFor(`document.body.textContent.includes('workerValue: 73') && document.querySelector('button[aria-label="调试线程"]')?.textContent.includes('code-studio-worker')`);
    const original = await window.webContents.executeJavaScript(`fetch('/api/local/projects/${project.id}/java-run').then(response => response.json())`);
    const main = original.threads.find(thread => thread.name === 'main' || thread.name === 'Thread [main]'); const worker = original.threads.find(thread => thread.name.includes('code-studio-worker')); assert.ok(main, JSON.stringify(original.threads)); assert.ok(worker);
    async function select(thread) {
      await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="调试线程"]').click()`);
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('[role="option"]')].find(option => option.textContent.trim() === ${JSON.stringify(thread.name + ' · ' + thread.id)}).click()`);
    }
    await select(main);
    await waitFor(`document.body.textContent.includes('所选线程没有可查看的调用栈')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent === '暂停所选线程').click()`);
    await waitFor(`document.body.textContent.includes('mainValue: 42') && !document.body.textContent.includes('workerValue: 73') && !!document.querySelector('.desktop-java-current-line')`);
    const selected = await window.webContents.executeJavaScript(`fetch('/api/local/projects/${project.id}/java-run').then(response => response.json())`);
    assert.equal(selected.threadId, main.id); assert.ok(selected.stopVersion > original.stopVersion); assert.ok(selected.frames.some(frame => frame.path === 'src/main/java/Main.java'));
    const stale = await window.webContents.executeJavaScript(`fetch('/api/local/projects/${project.id}/java-run/scopes', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sessionId:${JSON.stringify(original.sessionId)},stopVersion:${original.stopVersion},frameId:${original.frames[0].id}}) }).then(response=>response.status)`);
    assert.equal(stale, 400);
    await select(worker); await waitFor(`document.body.textContent.includes('workerValue: 73') && !document.body.textContent.includes('mainValue: 42')`);
    const beforeRefresh = await window.webContents.executeJavaScript(`fetch('/api/local/projects/${project.id}/java-run').then(response => response.json())`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent === '刷新线程').click()`);
    await waitFor(`!!document.querySelector('button[title="继续"]:not(:disabled)')`);
    const afterRefresh = await window.webContents.executeJavaScript(`fetch('/api/local/projects/${project.id}/java-run').then(response => response.json())`); assert.equal(afterRefresh.stopVersion, beforeRefresh.stopVersion);
    await window.webContents.executeJavaScript(`document.querySelector('button[title="单步跳过"]').click()`);
    await waitFor(`document.body.textContent.includes('Worker.run():7') && document.body.textContent.includes('workerValue: 73')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent === '继续所有线程').click()`);
    await waitFor(`document.body.textContent.includes('Debug · 已结束')`);
    console.log('Java threads UI passed: real worker/main thread selection, independent locals 73/42, automatic source location, stale scopes rejected, refresh preserves pause, selected-thread stepping and continue terminates.');
  } catch (error) { console.error(error); if (window) console.error(await window.webContents.executeJavaScript('document.body.innerText.slice(-3000)').catch(() => 'window unavailable')); exitCode = 1; }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(exitCode); }
});
