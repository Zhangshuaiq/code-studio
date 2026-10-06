const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLocalApi } = require('../src/local-api.cjs');

let api; let window; let directory; let exitCode = 0;
const deadline = setTimeout(() => { console.error('Workspace smoke test timed out'); app.exit(1); }, 60_000);
async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`UI condition not reached: ${expression}`);
}
app.whenReady().then(async () => {
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tabs-smoke-'));
    const projectRoot = path.join(directory, 'Workspace tab smoke'); fs.mkdirSync(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'sample.txt'), 'Workspace switching smoke test');
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3') });
    api.registerWorkspace(projectRoot);
    window = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    window.webContents.on('console-message', (_event, _level, message) => { if (/error|uncaught/i.test(message)) console.error(message); });
    await window.loadURL(api.origin);
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Workspace tab smoke')`);
    await window.webContents.executeJavaScript(`window.__requests = []; const originalFetch = window.fetch; window.fetch = (...args) => { window.__requests.push(String(args[0])); return originalFetch(...args); }; [...document.querySelectorAll('button h2')].find(node => node.textContent === 'Workspace tab smoke').closest('button').click();`);
    await waitFor(`!!document.querySelector('.workspace-frame') && [...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'sample.txt')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'sample.txt').click();`);
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('Workspace')`);
    await window.webContents.executeJavaScript(`window.__editor = document.querySelector('.monaco-editor'); document.querySelector('.monaco-editor textarea').focus();`);
    await window.webContents.executeJavaScript(`new Promise((resolve) => window.require(['vs/editor/editor.main'], (editorModule) => { const monaco = window.monaco || editorModule; const model = monaco.editor.getModels().find(model => model.uri.path.endsWith('sample.txt')); model.setValue('Unsaved workspace content'); resolve(); }))`);
    await waitFor(`!!document.querySelector('button[title="sample.txt"] .rounded-full')`);
    await window.webContents.executeJavaScript(`window.__workspace = document.querySelector('.workspace-frame'); window.__loads = window.__requests.filter(url => ['/files', '/index', '/language/prepare'].some(suffix => url.split('?')[0].endsWith(suffix))).length; [...document.querySelectorAll('aside button')].find(node => node.textContent.trim() === '数据源').click();`);
    await waitFor(`document.querySelector('.workspace-frame')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'true'`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('main button')].find(node => node.textContent.trim() === 'Workspace tab smoke').click();`);
    await waitFor(`document.querySelector('.workspace-frame')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false'`);
    const result = await window.webContents.executeJavaScript(`({ sameInstance: document.querySelector('.workspace-frame') === window.__workspace, before: window.__loads, after: window.__requests.filter(url => ['/files', '/index', '/language/prepare'].some(suffix => url.split('?')[0].endsWith(suffix))).length })`);
    assert.equal(result.sameInstance, true); assert.equal(result.after, result.before);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.monaco-editor') === window.__editor && !!document.querySelector('button[title="sample.txt"] .rounded-full')`), true);
    console.log('Workspace tab smoke passed: instance retained; tree/index/prewarm requests did not repeat.');
  } catch (error) { console.error(error); exitCode = 1; }
  finally {
    clearTimeout(deadline); window?.destroy(); await api?.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
