const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { createLocalApi } = require('../src/local-api.cjs');
const { LocalStore } = require('../src/local-store.cjs');
let api, window, directory;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('SQL UI smoke timed out'); app.exit(1); }, 60000);
const evaluate = async expression => {
  try { return await window.webContents.executeJavaScript(expression); }
  catch (error) { console.error('Failed UI expression:', expression); throw error; }
};
async function waitFor(expression) {
  for (let i = 0; i < 150; i++) { if (await evaluate(`(() => { try { return (${expression}); } catch { return false; } })()`)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`UI condition not reached: ${expression}`);
}
app.whenReady().then(async () => {
  let code = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-sql-ui-'));
    const root = path.join(directory, 'SQL fixture'); fs.mkdirSync(root);
    const schema = 'CREATE TABLE users (original_column TEXT);';
    const query = 'SELECT u. FROM users AS u JOIN orders o ON u.id=o.user_id;';
    fs.writeFileSync(path.join(root, 'schema.sql'), schema); fs.writeFileSync(path.join(root, 'query.sql'), query);
    const storePath=path.join(directory,'store.sqlite3');const store=new LocalStore(storePath);store.upsertConnector({id:'123456789012345678901234',name:'Bound DB',type:'postgres',settings:{host:'localhost',port:5432,database:'fixture_db'}},null);store.close();const metadataCalls=[];
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath, connectorRuntime:{async metadata(_config,_secret,input){metadataCalls.push(input);return{items:input.action==='databases'?[{name:'fixture_db'}]:input.action==='tables'?[{schema:'public',name:'users'},{schema:'public',name:'orders'}]:[{name:input.table==='orders'?'order_column':'bound_column',type:'text'}],truncated:false};},async explore(){throw Error('SQL binding must never execute SQL');}} });
    api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1440, height: 950, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `sql-ui-${Date.now()}` } });
    window.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') console.error('Renderer:', details.message); });
    await window.loadURL(api.origin);
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'SQL fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'SQL fixture').closest('button').click()`);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'schema.sql')`);
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'schema.sql').click()`);
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('original_column')`);
    await evaluate(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { window.__monaco = window.monaco || module; window.__editor = () => window.__monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === 'codegen' && editor.getDomNode()?.isConnected); resolve(); }))`);
    await evaluate(`window.__editor().setValue('CREATE TABLE users (draft_column TEXT);')`);
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'query.sql').click()`);
    await waitFor(`window.__editor().getModel().uri.path.endsWith('/query.sql') && window.__editor().getValue().includes('FROM users')`);
    assert.equal(await evaluate(`window.__editor().getModel().getLanguageId()`), 'sql');
    await evaluate(`window.__editor().setPosition({ lineNumber: 1, column: 10 }); window.__editor().focus(); window.__editor().trigger('test', 'editor.action.triggerSuggest', {});`);
    await waitFor(`document.querySelector('.suggest-widget')?.textContent.includes('draft_column')`);
    assert.equal(await evaluate(`document.querySelector('.suggest-widget')?.textContent.includes('original_column')`), false);
    assert.equal(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'), schema);
    assert.equal(fs.readFileSync(path.join(root, 'query.sql'), 'utf8'), query);
    await evaluate(`window.__editor().trigger('test','hideSuggestWidget',{})`);
    async function select(label,option){await evaluate(`[...document.querySelectorAll('[data-workspace-sql-binding] button')].find(node=>node.textContent.trim()===${JSON.stringify(label)}).click()`);await waitFor(`[...document.querySelectorAll('[role="option"]')].some(node=>node.textContent.trim()===${JSON.stringify(option)})`);await evaluate(`[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent.trim()===${JSON.stringify(option)}).click()`);}
    await select('未绑定连接','Bound DB');await select('选择数据库','fixture_db');
    await waitFor(`document.querySelector('[data-workspace-sql-binding]').textContent.includes('表/列提示就绪')`);
    assert.ok(metadataCalls.some(input=>input.action==='columns'&&input.table==='users'));
    assert.ok(metadataCalls.some(input=>input.action==='columns'&&input.table==='orders'));
    await evaluate(`window.__editor().focus();window.__editor().trigger('test','editor.action.triggerSuggest',{})`);
    await waitFor(`document.querySelector('.suggest-widget')?.textContent.includes('bound_column')`);
    assert.equal(await evaluate(`document.querySelector('.suggest-widget')?.textContent.includes('order_column')`),false);
    await evaluate(`window.__editor().trigger('test','hideSuggestWidget',{})`);
    await select('提示表（可选）','"public"."users"');
    await waitFor(`document.querySelector('[data-workspace-sql-binding]').textContent.includes('表/列提示就绪')`);
    await evaluate(`window.__editor().focus();window.__editor().trigger('test','editor.action.triggerSuggest',{})`);
    await waitFor(`document.querySelector('.suggest-widget')?.textContent.includes('bound_column')`);
    assert.equal(await evaluate(`document.querySelector('.suggest-widget')?.textContent.includes('draft_column')`),false);
    assert.ok(metadataCalls.some(input=>input.action==='columns'&&input.database==='fixture_db'&&input.schema==='public'&&input.table==='users'));
    const projects=await (await fetch(api.origin+'/api/local/projects',{headers:{Authorization:`Bearer ${api.token}`}})).json();
    await waitFor(`fetch('/api/local/projects/${projects.items[0].id}/sql-binding').then(response=>response.json()).then(body=>body.preference?.table==='"public"."users"')`);
    await evaluate(`window.__monaco.editor.getModels().filter(model=>model.uri.path.endsWith('/schema.sql')).forEach(model=>model.setValue(${JSON.stringify('CREATE TABLE users (original_column TEXT);')}));`);
    await window.webContents.reload();
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'SQL fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'SQL fixture').closest('button').click()`);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'query.sql')`);
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'query.sql').click()`);
    await waitFor(`document.querySelector('[data-workspace-sql-binding]')?.textContent.includes('表/列提示就绪')`);
    assert.ok(await evaluate(`document.querySelector('[data-workspace-sql-binding]').textContent.includes('Bound DB') && document.querySelector('[data-workspace-sql-binding]').textContent.includes('fixture_db') && document.querySelector('[data-workspace-sql-binding]').textContent.includes('"public"."users"')`));
    console.log('SQL UI: lazy parser, DDL drafts, alias columns and restored connection/database/table binding passed; files unchanged');
  } catch (error) { code = 1; console.error(error); }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(code); }
});
