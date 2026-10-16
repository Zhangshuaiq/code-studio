const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { LocalLspManager } = require('@codegen/code-intelligence');
const { LocalJavaRuntime } = require('../src/local-java-runtime.cjs');
const { createLocalApi } = require('../src/local-api.cjs');
let phase = 'importing', targetsCalls = 0;
// UI scheduling only: no JVM, real project, credentials or business execution.
LocalLspManager.prototype.prepareProject = async () => ({ providers: [{ provider: 'java', ready: true }] });
LocalLspManager.prototype.projectStatus = () => ({ providers: [{ provider: 'java', phase, elapsedMs: 1000, message: phase, backgroundTasks: phase === 'ready' ? 0 : 1 }] });
LocalJavaRuntime.prototype.targets = async () => { targetsCalls++; return [{ mainClass: 'demo.Main', label: 'Main' }]; };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-discovery-scheduling-'));
fs.mkdirSync(path.join(directory, 'electron')); app.setPath('userData', path.join(directory, 'electron'));
app.on('window-all-closed', () => {});
let api, window;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Java discovery scheduling timed out'); app.exit(1); }, 45000);
const evaluate = expression => window.webContents.executeJavaScript(expression);
async function wait(expression) {
  for (let i = 0; i < 150; i++) { if (await evaluate(`(()=>{try{return (${expression})}catch{return false}})()`)) return; await delay(100); }
  throw new Error(`UI condition not met: ${expression}`);
}
app.whenReady().then(async () => {
  let code = 0;
  try {
    const root = path.join(directory, 'Scheduling fixture'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'Main.java'), 'class Main {}');
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3') });
    api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadURL(api.origin);
    await wait(`[...document.querySelectorAll('button h2')].some(node=>node.textContent==='Scheduling fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(node=>node.textContent==='Scheduling fixture').closest('button').click()`);
    await wait(`!!document.querySelector('[aria-label="Java 启动入口"]')`);
    await delay(2200); assert.equal(targetsCalls, 0, 'import must not race main-class discovery');
    assert.ok(await evaluate(`document.querySelector('[aria-label="Java 启动入口"]').textContent.includes('正在准备')`));
    phase = 'indexing'; await delay(2200); assert.equal(targetsCalls, 0, 'background indexing must not race discovery');
    phase = 'ready';
    await wait(`document.querySelector('[aria-label="Java 启动入口"]').textContent.includes('Main')`);
    assert.equal(targetsCalls, 1);
    await delay(2200); assert.equal(targetsCalls, 1, 'ready polling must not repeat discovery');
    phase = 'indexing';
    await evaluate(`document.querySelector('button[title="刷新运行配置"]').click()`);
    await delay(300); assert.equal(targetsCalls, 2, 'explicit refresh must bypass background scheduling');
    console.log(JSON.stringify({ passed: true, importingCalls: 0, indexingCalls: 0, readyCalls: 1, manualRefreshCalls: targetsCalls }));
  } catch (error) { console.error(error); code = 1; }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); app.exit(code); }
});
