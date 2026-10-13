const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalApi } = require('../src/local-api.cjs');
let api, window, directory;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Bash UI smoke timed out'); app.exit(1); }, 60000);
async function evaluate(expression) { return window.webContents.executeJavaScript(expression); }
async function waitFor(expression) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`UI condition not reached: ${expression}`);
}
app.whenReady().then(async () => {
  let code = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-bash-ui-'));
    const root = path.join(directory, 'Shell fixture'); fs.mkdirSync(root);
    const baseline = '#!/usr/bin/env bash\nBASELINE=hello\necho "$BASELINE"\n';
    fs.writeFileSync(path.join(root, 'run.sh'), baseline);
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3') });
    api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1440, height: 950, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `bash-ui-${Date.now()}` } });
    await window.loadURL(api.origin);
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Shell fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Shell fixture').closest('button').click()`);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'run.sh')`);
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'run.sh').click()`);
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('BASELINE')`);
    await evaluate(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { window.__monaco = window.monaco || module; window.__editor = window.__monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === 'codegen' && editor.getDomNode()?.isConnected); resolve(); }))`);
    assert.equal(await evaluate(`window.__editor.getModel().getLanguageId()`), 'shell');
    const draft = '#!/usr/bin/env bash\nDRAFT_VALUE=hello\necho "$DRAFT_"\n';
    await evaluate(`window.__editor.setValue(${JSON.stringify(draft)}); window.__editor.setPosition({lineNumber:3,column:14}); window.__editor.focus(); window.__editor.trigger('test', 'editor.action.triggerSuggest', {});`);
    await waitFor(`document.querySelector('.suggest-widget')?.textContent.includes('DRAFT_VALUE')`);
    assert.equal(fs.readFileSync(path.join(root, 'run.sh'), 'utf8'), baseline);
    console.log('Bash UI: actual Monaco completion from unsaved content passed; workspace file unchanged');
  } catch (error) { code = 1; console.error(error); }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(code); }
});
