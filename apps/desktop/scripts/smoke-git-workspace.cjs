const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createLocalApi } = require('../src/local-api.cjs');
let api, window, directory;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Git UI smoke timed out'); app.exit(1); }, 60_000);
const evaluate = expression => window.webContents.executeJavaScript(expression);
async function waitFor(expression) {
  for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`UI condition not reached: ${expression}`);
}
const button = label => `[...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)})`;
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workspace-ui-'));
    const workspace = path.join(directory, 'Git fixture'); fs.mkdirSync(workspace);
    const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-qb', 'main'); git('config', 'user.name', 'UI Test'); git('config', 'user.email', 'ui@example.test');
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'main version'); fs.writeFileSync(path.join(workspace, 'b.txt'), 'main b');
    git('add', '.'); git('commit', '-qm', 'Initial UI commit');
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3') });
    api.registerWorkspace(workspace);
    window = new BrowserWindow({ show: false, width: 1440, height: 950, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `git-ui-${Date.now()}` } });
    await window.loadURL(api.origin);
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Git fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Git fixture').closest('button').click()`);
    await waitFor(`Boolean(${button('a.txt')})`); await evaluate(`${button('a.txt')}.click()`);
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('main')`);
    await evaluate(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { window.__monaco = window.monaco || module; window.__editor = () => window.__monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === 'codegen' && editor.getDomNode()?.isConnected); resolve(); }))`);
    await evaluate(`${button('分支 / 变更')}.click()`);
    await waitFor(`document.querySelector('button[title="创建分支"]')?.disabled === false`);
    await evaluate(`document.querySelector('button[title="创建分支"]').click()`);
    await waitFor(`document.querySelector('[role="dialog"] input')`);
    await evaluate(`(() => { const input = document.querySelector('[role="dialog"] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'feature/ui'); input.dispatchEvent(new Event('input', { bubbles:true })); })()`);
    await evaluate(`${button('创建分支')}.click()`);
    await waitFor(`!document.querySelector('[role="dialog"]') && document.querySelector('button[aria-label="当前分支"]')?.textContent.includes('feature/ui')`);
    assert.equal(git('branch', '--show-current').trim(), 'feature/ui');
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'feature version'); git('add', 'a.txt'); git('commit', '-qm', 'Feature UI commit');
    // Refresh detects external Git changes, then switch branches using the CSS select.
    await evaluate(`document.querySelector('button[title="刷新 Git 状态"]').click()`);
    await waitFor(`document.querySelector('button[aria-label="当前分支"]')?.disabled === false`);
    await evaluate(`document.querySelector('button[aria-label="当前分支"]').click()`);
    await waitFor(`[...document.querySelectorAll('[role="option"]')].some(node => node.textContent.trim() === 'main')`);
    await evaluate(`[...document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim() === 'main').click()`);
    await waitFor(`window.__editor()?.getModel()?.getValue() === 'main version' && document.querySelector('button[aria-label="当前分支"]')?.textContent.includes('main')`);
    await waitFor(`document.querySelector('button[aria-label="当前分支"]')?.disabled === false`);
    await evaluate(`document.querySelector('button[aria-label="当前分支"]').click()`);
    await waitFor(`[...document.querySelectorAll('[role="option"]')].some(node => node.textContent.trim() === 'feature/ui')`);
    await evaluate(`[...document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim() === 'feature/ui').click()`);
    await waitFor(`window.__editor()?.getModel()?.getValue() === 'feature version'`);
    await evaluate(`${button('历史')}.click()`);
    await waitFor(`document.body.textContent.includes('Feature UI commit') && document.querySelector('.monaco-diff-editor')`);
    assert.equal(await evaluate(`document.body.textContent.includes('Initial UI commit')`), true);
    await evaluate(`${button('代码')}.click(); window.__editor().setValue('unsaved draft')`);
    await waitFor(`document.body.textContent.includes('未保存')`);
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim().startsWith('分支 / 变更')).click()`);
    await waitFor(`document.querySelector('button[aria-label="当前分支"]')?.disabled === false`);
    await evaluate(`document.querySelector('button[aria-label="当前分支"]').click()`);
    await waitFor(`[...document.querySelectorAll('[role="option"]')].some(node => node.textContent.trim() === 'main')`);
    await evaluate(`[...document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim() === 'main').click()`);
    await waitFor(`document.body.textContent.includes('请先保存编辑器中的修改')`);
    assert.equal(git('branch', '--show-current').trim(), 'feature/ui');
    assert.equal(await evaluate(`window.__editor().getValue()`), 'unsaved draft');
    console.log('Git UI smoke passed: CSS branch dialog, branch switching, refreshed editor buffers, shared history/diff and unsaved-draft protection.');
  } catch (error) { exitCode = 1; console.error(error); if (window && !window.isDestroyed()) console.error(await evaluate(`JSON.stringify({ text: document.body.textContent.slice(-5000), value: window.__editor?.()?.getModel()?.getValue() })`)); }
  finally { if (window && !window.isDestroyed()) window.destroy(); await api?.close(); if (directory) fs.rmSync(directory, { recursive:true, force:true }); clearTimeout(deadline); app.exit(exitCode); }
});
