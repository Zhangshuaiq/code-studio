// Real desktop renderer + real Local API/SQLite worker. All files and state are
// temporary; no user workspace, account or installed client is modified.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const packageRoot = process.env.CODE_STUDIO_TEST_PACKAGE;
const { createLocalApi } = require(packageRoot ? path.join(packageRoot, 'src/local-api.cjs') : '../src/local-api.cjs');
if (packageRoot) {
  assert.equal(path.basename(packageRoot), 'app.asar', 'package validation must use the actual archive');
  for (const name of ['@codegen/code-intelligence/fast-index-worker.cjs', 'web-tree-sitter/web-tree-sitter.wasm', 'tree-sitter-java/tree-sitter-java.wasm', 'exceljs']) {
    const resolved = require.resolve(name, { paths: [packageRoot] });
    assert.ok(resolved.startsWith(packageRoot + path.sep), `${name} must resolve inside the archive, not the development workspace`);
    assert.ok(fs.existsSync(resolved));
  }
  const pdfDirectory = path.join(packageRoot, 'renderer/pdfjs');
  const versions = fs.readdirSync(pdfDirectory);
  assert.equal(versions.length, 1);
  for (const folder of ['cmaps', 'standard_fonts', 'wasm']) assert.ok(fs.readdirSync(path.join(pdfDirectory, versions[0], folder)).length > 0, `packaged PDF ${folder} resources are required`);
}
let api, window, directory, warmClient;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Desktop draft-index smoke timed out'); app.exit(1); }, 90_000);
async function evaluate(expression) {
  try { return await window.webContents.executeJavaScript(expression); }
  catch (error) { throw new Error(`${error.message}\nExpression: ${expression}`); }
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`UI condition not reached: ${expression}`);
}
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-draft-index-'));
    const root = path.join(directory, 'Draft index fixture'); fs.mkdirSync(root);
    const baseline = 'class SavedService { void savedMethod() {} }';
    fs.writeFileSync(path.join(root, 'A.java'), baseline);
    fs.writeFileSync(path.join(root, 'B.java'), 'class OtherService {}');
    fs.mkdirSync(path.join(root, 'Empty folder'));
    fs.writeFileSync(path.join(root, '图片.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRuoAAAAASUVORK5CYII=', 'base64'));
    fs.writeFileSync(path.join(root, 'manual.pdf'), require('./preview-fixture-pdf.cjs')());
    fs.writeFileSync(path.join(root, 'rows.csv'), '名称,数量\n苹果,3\n');
    const workbook = new (require('exceljs').Workbook)(); workbook.addWorksheet('数据').addRow(['苹果', 3]); workbook.addWorksheet('Other').addRow(['second sheet']);
    await workbook.xlsx.writeFile(path.join(root, 'report.xlsx'));
    const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: root });
    git('init', '-q'); git('config', 'user.name', 'BlameAuthor'); git('config', 'user.email', 'blame@example.test'); git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Blame initial');
    api = await createLocalApi({ staticDir: packageRoot ? path.join(packageRoot, 'renderer') : path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3'), lspDataRoot: path.join(directory, 'language') });
    const project = api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1440, height: 950, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `draft-index-${Date.now()}` } });
    const externalRequests = [], failedPdfAssets = [], loadedPdfAssets = [];
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const external = /^https?:/.test(details.url) && new URL(details.url).origin !== api.origin;
      if (external) externalRequests.push(details.url);
      callback({ cancel: external });
    });
    window.webContents.session.webRequest.onCompleted(details => {
      if (/\/pdfjs\/|pdf\.worker/.test(details.url)) {
        if (details.statusCode >= 400) failedPdfAssets.push(details.statusCode);
        else loadedPdfAssets.push(details.url);
      }
    });
    window.webContents.on('console-message', event => { if (event.level === 3) console.error(event.message); });
    await window.loadURL(api.origin);
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Draft index fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Draft index fixture').closest('button').click()`);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'A.java')`);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Empty folder')`);
    await evaluate(`(() => { const row = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Empty folder'); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: row.getBoundingClientRect().x + 20, clientY: row.getBoundingClientRect().y + 10 })); })()`);
    await waitFor(`!!document.querySelector('[role="menu"]')`);
    await evaluate(`[...document.querySelectorAll('[role="menu"] button')].find(node => node.textContent === '新建文件夹').click()`);
    await waitFor(`!!document.querySelector('[role="dialog"] input')`);
    await evaluate(`(() => { const input = document.querySelector('[role="dialog"] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'New empty'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent === '确认').click()`);
    await waitFor(`!document.querySelector('[role="dialog"]')`);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'New empty')`);
    assert.ok(fs.statSync(path.join(root, 'Empty folder/New empty')).isDirectory());
    await evaluate(`void (window.confirm = () => true)`);
    await evaluate(`(() => { const row = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'New empty'); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: row.getBoundingClientRect().x + 20, clientY: row.getBoundingClientRect().y + 10 })); })()`);
    await waitFor(`!!document.querySelector('[role="menu"]')`);
    await evaluate(`[...document.querySelectorAll('[role="menu"] button')].find(node => node.textContent === '删除文件夹').click()`);
    await waitFor(`![...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'New empty')`);
    assert.equal(fs.existsSync(path.join(root, 'Empty folder/New empty')), false);
    console.log('File tree UI passed: existing empty folders, right-click create/delete and refreshed action callbacks.');
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'A.java').click()`);
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('SavedService')`);
    await evaluate(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { window.__monaco = window.monaco || module; window.__editor = () => window.__monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === 'codegen' && editor.getDomNode()?.isConnected); resolve(); }))`);
    await waitFor(`!!window.__editor()?.getModel()`);
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '行注释').click()`);
    await waitFor(`[...document.querySelectorAll('.line-numbers')].some(node => node.textContent.includes('BlameAuthor'))`);
    await evaluate(`document.querySelector('.line-numbers').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: document.querySelector('.line-numbers').getBoundingClientRect().x + 10, clientY: document.querySelector('.line-numbers').getBoundingClientRect().y + 5 }))`);
    await waitFor(`!!document.querySelector('[aria-label="行注释提交详情"]')`);
    await waitFor(`document.querySelector('[aria-label="行注释提交详情"]').textContent.includes('A.java')`);
    await evaluate(`[...document.querySelectorAll('[aria-label="行注释提交详情"] button')].find(button => button.textContent === '关闭').click()`);
    await evaluate(`window.__editor().getModel().setValue(${JSON.stringify('\nclass DraftService { void draftMethod() {} }')})`);
    await evaluate(`(() => { window.__editor().focus(); return window.__editor().getAction('editor.action.quickOutline').run(); })()`);
    await waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('draftMethod')`);
    assert.ok(await evaluate(`document.querySelector('.quick-input-widget').textContent.includes('DraftService')`));
    assert.equal(await evaluate(`document.querySelector('.quick-input-widget').textContent.includes('SavedService')`), false);
    await evaluate(`(() => { const row = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find(row => row.textContent.includes('draftMethod')); row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })); row.click(); })()`);
    await waitFor(`!document.querySelector('.quick-input-widget')?.offsetHeight`);
    await waitFor(`[...document.querySelectorAll('.line-numbers')].some(node => node.textContent.includes('未提交修改'))`);
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '行注释').click()`);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true }))`);
    await waitFor(`!!document.querySelector('input[placeholder="文件名；@ 符号；# 全文；> 动作"]')`);
    await evaluate(`(() => { const input = document.querySelector('input[placeholder="文件名；@ 符号；# 全文；> 动作"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '@Service'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.includes('DraftService') && button.textContent.includes('class · A.java:2'))`);
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(button => button.textContent.includes('SavedService') && button.textContent.includes('class · A.java:1'))`), false);
    await evaluate(`window.__editor().getModel().setValue(${JSON.stringify('\nclass UpdatedService { void draftMethod() {} }')})`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.includes('UpdatedService') && button.textContent.includes('class · A.java:2'))`);
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('UpdatedService') && button.textContent.includes('class · A.java:2')).click()`);
    await waitFor(`window.__editor().getPosition().lineNumber === 2 && window.__editor().getPosition().column === 7`);
    assert.equal(fs.readFileSync(path.join(root, 'A.java'), 'utf8'), baseline);
    const openPreview = file => evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(file)}).click()`);
    await openPreview('图片.png');
    await waitFor(`document.querySelector('img[alt="图片.png"]')?.naturalWidth === 1`);
    assert.ok(await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存').disabled`));
    await openPreview('manual.pdf');
    await waitFor(`!!document.querySelector('[data-pdf-rendered="true"]') && document.querySelector('[data-pdf-text]')?.textContent.includes('Code Studio PDF preview')`);
    await evaluate(`[...document.querySelectorAll('[data-pdf-viewer] button')].find(button => button.textContent === '下一页').click()`);
    await waitFor(`document.querySelector('[data-pdf-text]')?.textContent.includes('second page')`);
    await openPreview('report.xlsx');
    await waitFor(`document.querySelector('table')?.textContent.includes('苹果')`);
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Other').click()`);
    await waitFor(`document.querySelector('table')?.textContent.includes('second sheet')`);
    await openPreview('rows.csv');
    await waitFor(`document.querySelector('table')?.textContent.includes('苹果')`);
    await openPreview('A.java');
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('UpdatedService')`);
    console.log('Desktop previews UI passed: shared image/PDF/table viewer, worksheet switching, read-only controls and unsaved text recovery.');
    const disk = await fetch(`${api.origin}/api/local/projects/${project.id}/language/fast-symbols?query=UpdatedService`, { headers: { Authorization: `Bearer ${api.token}` } });
    assert.equal(disk.status, 200); assert.equal((await disk.json()).items.length, 0);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true }))`);
    await waitFor(`!!document.querySelector('input[placeholder="文件名；@ 符号；# 全文；> 动作"]')`);
    await evaluate(`(() => { const input = document.querySelector('input[placeholder="文件名；@ 符号；# 全文；> 动作"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '@OtherService'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.includes('OtherService') && button.textContent.includes('class · B.java:1'))`);
    fs.writeFileSync(path.join(root, 'B.java'), '\n\nclass OtherService {}');
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('OtherService') && button.textContent.includes('class · B.java:1')).click()`);
    await waitFor(`[...document.querySelectorAll('button')].some(button => button.textContent.includes('OtherService') && button.textContent.includes('class · B.java:3'))`);
    assert.ok(await evaluate(`window.__editor().getModel().uri.path.endsWith('A.java')`), 'stale disk candidate must not switch the active file');
    assert.equal(await evaluate(`window.__editor().getPosition().lineNumber`), 2);
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('OtherService') && button.textContent.includes('class · B.java:3')).click()`);
    await waitFor(`window.__editor().getModel().uri.path.endsWith('B.java') && window.__editor().getPosition().lineNumber === 3 && window.__editor().getPosition().column === 7`);
    assert.equal(fs.readFileSync(path.join(root, 'A.java'), 'utf8'), baseline);
    assert.deepEqual(externalRequests, [], 'personal preview/index flows must not depend on remote services or a CDN');
    assert.deepEqual(failedPdfAssets, [], 'packaged PDF resources must load successfully');
    assert.ok(loadedPdfAssets.some(url => url.includes('pdf.worker')), 'must exercise the packaged PDF worker');
    console.log('Desktop draft-index UI passed: real SQLite worker, drafts, verified cursor, stale external-file rejection, background refresh and correct unopened-target retry.');
    window.destroy(); window = null;
    await api.close(); api = null;
    const databaseDirectory = path.join(directory, 'fast-index');
    const databases = fs.readdirSync(databaseDirectory).filter(name => name.endsWith('.sqlite3'));
    assert.equal(databases.length, 1, 'fixture must have one scoped persistent index');
    const clientModule = packageRoot ? require(require.resolve('@codegen/code-intelligence/fast-index-client.cjs', { paths: [packageRoot] })) : require('@codegen/code-intelligence/fast-index-client.cjs');
    warmClient = new clientModule.FastIndexClient({ root, databasePath: path.join(databaseDirectory, databases[0]) });
    assert.equal((await warmClient.status()).state, 'needs-validation');
    const restored = await warmClient.search('OtherService');
    assert.equal(restored.items[0].line, 3, 'must query persisted symbols before a new scan');
    assert.equal((await warmClient.search('UpdatedService')).items.length, 0, 'unsaved drafts must not enter the persistent index');
    const revalidated = await warmClient.refresh();
    assert.equal(revalidated.complete, true);
    assert.equal(revalidated.parsedFiles, 0, 'unchanged files must not be reparsed on warm reopen');
    assert.equal(revalidated.unchangedFiles, 2);
    await warmClient.close(); warmClient = null;
    console.log('Warm index reopen passed: persisted results available before validation, zero unchanged-file reparses and no saved draft leakage.');
    if (packageRoot) console.log('ASAR validation passed: archive-only dependencies, WASM/SQLite worker, local PDF assets and no external HTTP requests.');
  } catch (error) { console.error(error); exitCode = 1; if (window) console.error(await evaluate('document.body.innerText.slice(-2000)').catch(() => 'page unavailable')); }
  finally { window?.destroy(); await warmClient?.close(); await api?.close(); clearTimeout(deadline); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(exitCode); }
});
