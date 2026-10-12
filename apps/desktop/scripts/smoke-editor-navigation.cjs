const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLocalApi } = require('../src/local-api.cjs');

let api, window, directory;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Editor navigation smoke timed out'); app.exit(1); }, 90_000);
async function evaluate(expression) { return window.webContents.executeJavaScript(expression); }
async function waitFor(expression) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`UI condition not reached: ${expression}`);
}
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-navigation-'));
    const root = path.join(directory, 'Navigation fixture'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'Source.ts'), 'export interface Greeting {\n  message(): string;\n}\n\nexport const marker = 1;\n');
    fs.writeFileSync(path.join(root, 'Implementation.ts'), 'import { Greeting } from "./Source";\nexport class GreetingImpl implements Greeting {\n  message() { return "hello"; }\n}\n');
    fs.writeFileSync(path.join(root, 'UnopenedUsage.ts'), 'import { Greeting } from "./Source";\nexport const greeting: Greeting = { message() { return "usage"; } };\nexport const output = greeting.message();\n');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['*.ts'] }));
    fs.mkdirSync(path.join(root, 'big'));
    for (let group = 0; group < 20; group++) {
      const folder = path.join(root, 'big', `group-${group}`); fs.mkdirSync(folder);
      for (let file = 0; file < 50; file++) fs.writeFileSync(path.join(folder, `large-file-${file}.txt`), 'fixture');
    }
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3') });
    const project = api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1440, height: 950, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `navigation-${Date.now()}` } });
    window.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') console.error('Renderer:', details.message); });
    await window.loadURL(api.origin);
    await waitFor(`[...document.querySelectorAll('button h2')].some(node => node.textContent === 'Navigation fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(node => node.textContent === 'Navigation fixture').closest('button').click()`);
    await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Source.ts')`);
    assert.equal(await evaluate(`document.body.textContent.includes('large-file-49.txt')`), false);
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Source.ts').click()`);
    await waitFor(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('Greeting')`);
    await evaluate(`new Promise(resolve => window.require(['vs/editor/editor.main'], module => { window.__monaco = window.monaco || module; window.__editor = () => window.__monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === 'codegen' && editor.getDomNode()?.isConnected); resolve(); }))`);
    assert.equal(await evaluate(`window.__monaco.editor.getModels().filter(model => model.uri.scheme === 'codegen').length`), 1);
    const prepared = await fetch(`${api.origin}/api/local/projects/${project.id}/language/prepare`, { method: 'POST', headers: { Authorization: `Bearer ${api.token}` } });
    assert.equal(prepared.status, 200);
    const implementation = await fetch(`${api.origin}/api/local/projects/${project.id}/language/implementation`, { method: 'POST', headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Source.ts', line: 1, column: 18 }) });
    const locations = await implementation.json();
    assert.ok(locations.result?.some(item => item.path === 'Implementation.ts'), JSON.stringify(locations));
    await evaluate(`window.__editor().setPosition({lineNumber:1,column:18}); window.__editor().focus(); window.__editor().getAction('desktop-open-implementation').run()`);
    await waitFor(`[...document.querySelectorAll('.peekview-widget .monaco-list-row')].some(node => node.textContent.includes('export class GreetingImpl'))`);
    await evaluate(`[...document.querySelectorAll('.peekview-widget .monaco-list-row')].find(node => node.textContent.includes('export class GreetingImpl')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await waitFor(`window.__editor()?.getModel()?.uri.path.endsWith('Implementation.ts')`);
    await waitFor(`document.querySelector('button[aria-label="返回上一处光标位置"]')?.disabled === false`);
    for (const [name, back, forward] of [
      ['IDEA 快捷键', { code: 'BracketLeft', key: '[', metaKey: true }, { code: 'BracketRight', key: ']', metaKey: true }],
      ['VS Code 快捷键', { code: 'Minus', key: '-', ctrlKey: true }, { code: 'Minus', key: '_', ctrlKey: true, shiftKey: true }],
      ['Eclipse 快捷键', { code: 'ArrowLeft', key: 'ArrowLeft', altKey: true }, { code: 'ArrowRight', key: 'ArrowRight', altKey: true }],
    ]) {
      await evaluate(`document.querySelector('button[aria-label="光标导航快捷键方案"]').click()`);
      await waitFor(`[...document.querySelectorAll('[role="option"]')].some(node => node.textContent.trim() === ${JSON.stringify(name)})`);
      await evaluate(`[...document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim() === ${JSON.stringify(name)}).click(); window.__editor().focus()`);
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ ...back, bubbles: true, cancelable: true })}))`);
      await waitFor(`window.__editor()?.getModel()?.uri.path.endsWith('Source.ts') && window.__editor().getPosition().lineNumber === 1 && window.__editor().getPosition().column === 18`);
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ ...forward, bubbles: true, cancelable: true })}))`);
      await waitFor(`window.__editor()?.getModel()?.uri.path.endsWith('Implementation.ts') && window.__editor().getPosition().lineNumber === 2`);
    }
    await evaluate(`window.__editor().setPosition({lineNumber:4,column:1}, 'keyboard')`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code:'ArrowLeft', key:'ArrowLeft', altKey:true, bubbles:true, cancelable:true }))`);
    await waitFor(`window.__editor()?.getModel()?.uri.path.endsWith('Implementation.ts') && window.__editor().getPosition().lineNumber === 2`);
    assert.equal(await evaluate(`window.localStorage.getItem('code-studio-editor-preferences').includes('eclipse')`), true);
    await evaluate(`window.__editor().setPosition({lineNumber:1,column:10}); window.__editor().trigger('audit', 'editor.action.peekDefinition', null)`);
    await waitFor(`document.querySelector('.peekview-widget')?.textContent.includes('Greeting')`);
    await evaluate(`window.__editor().trigger('audit', 'closeReferenceSearch', null)`);
    await evaluate(`window.__editor().trigger('audit', 'editor.action.quickOutline', null)`);
    await waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('GreetingImpl')`);
    await evaluate(`window.__editor().trigger('audit','quickInput.hide',null)`);
    await waitFor(`document.querySelector('.quick-input-widget')?.style.display === 'none'`);
    await evaluate(`window.__editor().trigger('audit', 'editor.action.quickCommand', null)`);
    await waitFor(`document.querySelector('.quick-input-widget input')?.getAttribute('aria-controls')`);
    await evaluate(`{ const input=document.querySelector('.quick-input-widget input'); input.value='>重命名'; input.dispatchEvent(new Event('input',{bubbles:true})); }`);
    await waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('重命名')`);
    await evaluate(`window.__editor().trigger('audit','quickInput.hide',null)`);
    await waitFor(`document.querySelector('.quick-input-widget')?.style.display === 'none'`);
    await evaluate(`[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='Source.ts').click()`);
    await waitFor(`window.__editor()?.getModel()?.uri.path.endsWith('Source.ts')`);
    await evaluate(`window.__editor().setPosition({lineNumber:1,column:18}); window.__editor().trigger('audit','editor.action.goToReferences',null)`);
    await waitFor(`document.querySelector('.peekview-widget')?.textContent.includes('UnopenedUsage.ts')`);
    await evaluate(`window.__editor().trigger('audit','closeReferenceSearch',null)`);
    await evaluate(`window.confirm = () => false; window.__editor().setPosition({lineNumber:1,column:18}); window.__editor().focus(); void window.__editor().trigger('audit','editor.action.rename',null)`);
    await waitFor(`document.activeElement === document.querySelector('.rename-box input')`);
    await evaluate(`{ const input=document.querySelector('.rename-box input'); input.value='CancelledName'; input.dispatchEvent(new Event('input',{bubbles:true})); } window.__editor().trigger('audit','acceptRenameInput',null)`);
    await waitFor(`document.querySelector('.rename-box')?.style.display === 'none'`);
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(await evaluate(`window.__monaco.editor.getModels().some(model=>model.getValue().includes('CancelledName'))`), false);
    await evaluate(`window.confirm = () => true; window.__editor().setPosition({lineNumber:1,column:18}); window.__editor().focus(); void window.__editor().trigger('audit','editor.action.rename',null)`);
    await waitFor(`document.querySelector('.rename-box input')?.offsetParent !== null && document.activeElement === document.querySelector('.rename-box input')`);
    await evaluate(`{ const input = document.querySelector('.rename-box input'); input.value = 'Salutation'; input.dispatchEvent(new Event('input',{bubbles:true})); }`);
    await evaluate(`window.__editor().trigger('audit','acceptRenameInput',null)`);
    await waitFor(`window.__monaco.editor.getModels().filter(model=>model.uri.scheme==='codegen' && model.getValue().includes('Salutation')).length === 3`);
    assert.ok(fs.readFileSync(path.join(root, 'UnopenedUsage.ts'), 'utf8').includes('Greeting'), 'rename must not write disk before save');
    await waitFor(`[...document.querySelectorAll('button')].some(node=>node.textContent.trim()==='UnopenedUsage.ts')`);
    const originalUsage = fs.readFileSync(path.join(root, 'UnopenedUsage.ts'), 'utf8');
    fs.writeFileSync(path.join(root, 'UnopenedUsage.ts'), originalUsage + '// external change\n');
    await evaluate(`[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='全部保存').click()`);
    await waitFor(`document.body.textContent.includes('磁盘文件已变化')`);
    assert.ok(fs.readFileSync(path.join(root, 'Source.ts'), 'utf8').includes('Greeting'), 'preflight must stop all writes on conflict');
    assert.ok(fs.readFileSync(path.join(root, 'UnopenedUsage.ts'), 'utf8').includes('// external change'));
    assert.equal(await evaluate(`window.__monaco.editor.getModels().filter(model=>model.uri.scheme==='codegen'&&model.getValue().includes('Salutation')).length`),3);
    fs.writeFileSync(path.join(root, 'UnopenedUsage.ts'), originalUsage);
    await evaluate(`[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='全部保存').click()`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (['UnopenedUsage.ts', 'Source.ts', 'Implementation.ts'].every(file=>fs.readFileSync(path.join(root, file),'utf8').includes('Salutation'))) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(fs.readFileSync(path.join(root, 'UnopenedUsage.ts'), 'utf8').includes('Salutation'));
    assert.ok(fs.readFileSync(path.join(root, 'Source.ts'), 'utf8').includes('Salutation'));
    await evaluate(`window.__editor().getModel().undo()`);
    await waitFor(`window.__editor().getModel().getValue().includes('interface Greeting')`);
    await waitFor(`[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='全部保存')?.disabled === false`);
    await evaluate(`window.__editor().getModel().redo()`);
    await waitFor(`window.__editor().getModel().getValue().includes('interface Salutation')`);
    console.log('Editor menu audit passed: native Peek, document symbols, Chinese command palette, native cross-file rename including unopened files, deferred disk writes and save all.');
    console.log('Desktop editor smoke passed: real TS implementation opens unopened file; exact cursor back/forward for IDEA/VS Code/Eclipse; same-file cursor history; persisted preference; 1000 collapsed files not rendered or loaded as models.');
  } catch (error) {
    console.error(error);
    if (window && !window.isDestroyed()) console.error(await evaluate('document.body.innerText.slice(-1500)').catch(() => ''));
    exitCode = 1;
  } finally {
    clearTimeout(deadline); window?.destroy(); await api?.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
