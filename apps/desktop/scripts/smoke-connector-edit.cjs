const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLocalApi } = require('../src/local-api.cjs');
const { LocalStore } = require('../src/local-store.cjs');

let api, window, directory;
const databaseCalls = [];
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Connector edit smoke timed out'); app.exit(1); }, 60_000);
const evaluate = expression => window.webContents.executeJavaScript(expression);
async function waitFor(expression) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`UI condition not reached: ${expression}`);
}
function field(label) { return `[...document.querySelectorAll('label')].find(node => node.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input')`; }
async function input(label, value) {
  await evaluate(`(() => { const node = ${field(label)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', {bubbles:true})); })()`);
}
const saveButton = `[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '保存修改')`;
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-edit-ui-'));
    const storePath = path.join(directory, 'store.sqlite3');
    const codec = { available: () => true, encrypt: value => Buffer.from(`protected:${value}`).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString().slice(10) };
    const store = new LocalStore(storePath);
    const id = '123456789012345678901234';
    // Simulate an existing configuration saved before host validation existed.
    store.upsertConnector({ id, name: 'Editing fixture', type: 'postgres', settings: { host: '10.62.172.112:5432', port: 5432, database: 'original', username: 'app', ssl: false } }, codec.encrypt('original-secret'));
    store.close();
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath, credentialCodec: codec, connectorRuntime: {
      async metadata(_config, _secret, input) {
        databaseCalls.push(input);
        return { items: input.action === 'databases' ? [{ name: 'updated' }] : input.action === 'tables' ? [{ schema: 'public', name: 'odd.table', type: 'BASE TABLE' }] : [{ name: 'id', type: 'integer', nullable: 'NO', default: null }, { name: 'value', type: 'text', nullable: 'YES', default: null }], truncated: false };
      },
      async explore(_config, _secret, input) {
        databaseCalls.push(input);
        assert.equal(input.readOnly, false, 'Personal SQL does not require approval');
        return { kind: 'table', columns: ['id', 'value'], rows: [{ id: 1, value: 'fixture-value' }], truncated: false };
      },
    } });
    window = new BrowserWindow({ show: false, width: 1440, height: 950, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `connector-edit-${Date.now()}` } });
    await window.loadURL(api.origin);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '数据源')`);
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '数据源').click()`);
    await waitFor(`document.querySelector('button[aria-label="编辑连接 Editing fixture"]')`);
    await evaluate(`document.querySelector('button[aria-label="编辑连接 Editing fixture"]').click()`);
    await waitFor(`Boolean(${field('主机（IP / 域名，不含端口）')})`);
    assert.equal(await evaluate(`${field('主机（IP / 域名，不含端口）')}.value`), '10.62.172.112:5432');
    assert.equal(await evaluate(`${field('密码（可选）')}.value`), '');
    assert.equal(await evaluate(`document.body.textContent.includes('original-secret')`), false);
    await evaluate(`${saveButton}.click()`);
    await waitFor(`document.body.textContent.includes('主机地址不要包含端口')`);
    await input('主机（IP / 域名，不含端口）', '10.62.172.112');
    await input('数据库', 'updated');
    await evaluate(`${saveButton}.click()`);
    await waitFor(`!${saveButton}`);
    const response = await fetch(`${api.origin}/api/local/connectors`, { headers: { Authorization: `Bearer ${api.token}` } });
    const rows = (await response.json()).items;
    assert.equal(rows.length, 1); assert.equal(rows[0].id, id);
    assert.equal(rows[0].settings.host, '10.62.172.112'); assert.equal(rows[0].settings.database, 'updated');
    assert.equal(rows[0].hasCredential, true);
    await evaluate(`document.querySelector('button[aria-label="编辑连接 Editing fixture"]').click()`);
    await waitFor(`Boolean(${field('数据库')})`);
    assert.equal(await evaluate(`${field('数据库')}.value`), 'updated');
    await input('密码（可选）', 'replacement-secret');
    await evaluate(`${saveButton}.click()`);
    await waitFor(`!${saveButton}`);
    const persisted = new LocalStore(storePath);
    assert.equal(codec.decrypt(persisted.getConnector(id).credentialCiphertext), 'replacement-secret');
    persisted.close();
    const remoteCalls = [];
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => { if (/\/admin\/datasources|\/db-query\//.test(details.url)) remoteCalls.push(details.url); callback({ cancel: false }); });
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Editing fixture').click()`);
    await waitFor(`document.querySelector('.workspace-frame aside')?.textContent.includes('odd.table')`);
    await evaluate(`[...document.querySelectorAll('.workspace-frame aside button')].find(node => node.textContent.includes('odd.table')).click()`);
    await waitFor(`document.querySelector('.cm-content')?.textContent.includes('"public"."odd.table"')`);
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.includes('表结构 · 点击展开')).click()`);
    await waitFor(`document.querySelector('.workspace-frame main')?.textContent.includes('integer')`);
    assert.ok(databaseCalls.some(input => input.action === 'columns' && input.schema === 'public' && input.table === 'odd.table'));
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '执行查询').click()`);
    await waitFor(`document.querySelector('.workspace-frame main')?.textContent.includes('fixture-value')`);
    assert.equal(await evaluate(`[...document.querySelectorAll('.workspace-frame main th')].some(node => node.textContent === 'value')`), true);
    assert.equal(await evaluate(`[...document.querySelectorAll('.workspace-frame main td')].some(node => node.textContent === 'fixture-value')`), true);
    assert.ok(databaseCalls.some(input => input.sql === 'SELECT * FROM "public"."odd.table" LIMIT 10;' && input.database === 'updated'));
    assert.deepEqual(remoteCalls, [], 'Local detail must never request remote database APIs');
    for (const label of ['导入', '导出', '备份', '迁移']) assert.equal(await evaluate(`[...document.querySelectorAll('.workspace-frame header button')].find(node => node.textContent.trim() === ${JSON.stringify(label)}).disabled`), true);
    await evaluate(`document.querySelector('button[aria-label="返回数据源列表"]').click()`);
    await waitFor(`document.querySelector('button[aria-label="编辑连接 Editing fixture"]')`);
    console.log('Connector smoke passed: editing, credential retention/replacement, shared web detail, table structure, SQL results, personal access, no remote API calls.');
  } catch (error) { exitCode = 1; console.error(error); }
  finally {
    if (window && !window.isDestroyed()) window.destroy();
    await api?.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    clearTimeout(deadline); app.exit(exitCode);
  }
});
