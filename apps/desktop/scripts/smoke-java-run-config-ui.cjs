const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const assert = require('node:assert/strict');
const { LocalJavaRuntime } = require('../src/local-java-runtime.cjs');
const { createLocalApi } = require('../src/local-api.cjs');
const targets = [
  { mainClass: 'com.example.very.long.company.platform.service.application.admin.FirstApplication', projectName: 'admin-module', label: 'FirstApplication' },
  { mainClass: 'com.example.very.long.company.platform.service.application.publicapi.FirstApplication', projectName: 'api-module', label: 'FirstApplication' },
];
// UI-only fixture: never starts a JVM or uses an existing project/credential.
LocalJavaRuntime.prototype.targets = async () => targets;
LocalJavaRuntime.prototype.environment = async () => ({ source: '17', target: '17', release: true, required: 17, buildTool: 'maven', selected: { home: '/fixture/jdk-17', version: '17.0.12' }, jdks: [{ home: '/fixture/jdk-17', version: '17.0.12', major: 17, vendor: 'Test JDK', arch: 'arm64' }, { home: '/fixture/jdk-21', version: '21.0.3', major: 21, vendor: 'Test JDK', arch: 'arm64' }, { home: '/fixture/jdk-11', version: '11.0.23', major: 11, vendor: 'Test JDK', arch: 'arm64' }] });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-run-config-ui-'));
fs.mkdirSync(path.join(directory, 'electron')); app.setPath('userData', path.join(directory, 'electron'));
let api, window;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Java run config UI timed out'); app.exit(1); }, 60000);
const evaluate = expression => window.webContents.executeJavaScript(expression);
async function waitFor(expression) {
  for (let i = 0; i < 200; i++) { if (await evaluate(`(()=>{try{return (${expression})}catch{return false}})()`)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`UI condition not reached: ${expression}`);
}
app.whenReady().then(async () => {
  let code = 0;
  try {
    const root = path.join(directory, 'Run config fixture'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'Main.java'), 'class Main { public static void main(String[] args) {} }');
    const credentialCodec = { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString('utf8') };
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath: path.join(directory, 'store.sqlite3'), credentialCodec });
    const project = api.registerWorkspace(root);
    window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadURL(api.origin);
    await waitFor(`[...document.querySelectorAll('button h2')].some(node=>node.textContent==='Run config fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(node=>node.textContent==='Run config fixture').closest('button').click()`);
    await waitFor(`document.querySelector('[aria-label="Java 启动入口"]')?.textContent.includes('FirstApplication')`);
    assert.ok(await evaluate(`document.querySelector('[aria-label="Java 启动入口"]').title.includes(${JSON.stringify(targets[0].mainClass)})`));
    await evaluate(`document.querySelector('[aria-label="Java 启动入口"]').click()`);
    await waitFor(`document.querySelectorAll('[role="option"]').length===2`);
    const menu = await evaluate(`(()=>{const menu=document.querySelector('[role="listbox"]'),rect=menu.getBoundingClientRect();return{width:rect.width,right:rect.right,text:menu.textContent,wrap:getComputedStyle(menu.querySelector('.break-all')).whiteSpace}})()`);
    assert.ok(menu.width >= 500); assert.ok(menu.right <= 1200); assert.equal(menu.wrap, 'normal');
    for (const target of targets) assert.ok(menu.text.includes(target.mainClass));
    await evaluate(`document.querySelectorAll('[role="option"]')[1].click()`);
    await waitFor(`document.querySelector('[aria-label="Java 启动入口"]').textContent.includes('api-module')`);
    await evaluate(`document.querySelector('[aria-label="启动配置"]').focus();document.querySelector('[aria-label="启动配置"]').click()`);
    await waitFor(`!!document.querySelector('[data-java-run-modal] [role="dialog"]')`);
    assert.equal(await evaluate(`!!document.querySelector('button[title="关闭面板"]')`), false);
    assert.equal(await evaluate(`document.querySelector('[data-java-main-class]').textContent`), targets[1].mainClass);
    await waitFor(`document.querySelector('[data-java-environment]').textContent.includes('source 17 / target 17')`);
    assert.ok(await evaluate(`document.querySelector('[aria-label="项目运行 JDK"]').textContent.includes('自动匹配项目')`));
    await evaluate(`document.querySelector('[aria-label="项目运行 JDK"]').click()`);
    await waitFor(`document.querySelectorAll('[role="option"]').length===4`);
    assert.equal(await evaluate(`[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent.includes('11.0.23')).disabled`), true);
    await evaluate(`[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent.includes('21.0.3')).click()`);
    await evaluate(`(()=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [label,value] of [['运行配置名称','API 开发'],['程序参数','--profile=dev'],['JVM 参数','-Xmx512m']]){const node=document.querySelector('input[aria-label="'+label+'"]');setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await evaluate(`[...document.querySelectorAll('[data-java-run-modal] button')].find(node=>node.textContent==='保存运行配置').click()`);
    await waitFor(`document.querySelector('[data-java-run-modal]').textContent.includes('运行配置已保存到本机')`);
    const saved = await evaluate(`fetch('/api/local/projects/${project.id}/java-run/configurations').then(r=>r.json())`);
    assert.equal(saved.configurations[0].mainClass, targets[1].mainClass); assert.equal(saved.configurations[0].args, '--profile=dev'); assert.equal(saved.configurations[0].vmArgs, '-Xmx512m');
    assert.equal(saved.configurations[0].javaHome, '/fixture/jdk-21');
    await evaluate(`document.querySelector('[aria-label="关闭运行配置"]').click()`);
    await waitFor(`!document.querySelector('[data-java-run-modal]')`);
    assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), '启动配置');
    await evaluate(`document.querySelector('button[title="运行 / 调试控制台"]').click()`);
    await waitFor(`!!document.querySelector('[data-java-run-panel]') && !!document.querySelector('[aria-label="调整运行面板高度"]')`);
    const before = await evaluate(`document.querySelector('[data-java-run-panel]').getBoundingClientRect().height`);
    const handle = await evaluate(`(()=>{const rect=document.querySelector('[aria-label="调整运行面板高度"]').getBoundingClientRect();return{x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}})()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...handle, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: handle.x, y: handle.y - 120, modifiers: ['leftButtonDown'] });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: handle.x, y: handle.y - 120, button: 'left', clickCount: 1 });
    await waitFor(`document.querySelector('[data-java-run-panel]').getBoundingClientRect().height>${before + 60}`);
    const enlarged = await evaluate(`document.querySelector('[data-java-run-panel]').getBoundingClientRect().height`);
    await evaluate(`document.querySelector('[aria-label="调整运行面板高度"]').focus()`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    await waitFor(`document.querySelector('[data-java-run-panel]').getBoundingClientRect().height<${enlarged - 2}`);
    await evaluate(`document.querySelector('button[title="关闭面板"]').click()`);
    await waitFor(`!document.querySelector('[data-java-run-panel]')`);
    await evaluate(`document.querySelector('button[title="运行 / 调试控制台"]').click()`);
    await waitFor(`document.querySelector('[data-java-run-panel]').getBoundingClientRect().height>${before + 30}`);
    console.log('Run panel resize passed: vertical drag, keyboard adjustment and restored size after reopening.');
    await window.reload();
    await waitFor(`[...document.querySelectorAll('button h2')].some(node=>node.textContent==='Run config fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(node=>node.textContent==='Run config fixture').closest('button').click()`);
    await waitFor(`!!document.querySelector('[aria-label="Java 启动入口"]:not(:disabled)')`);
    await evaluate(`document.querySelector('[aria-label="启动配置"]').click()`);
    await waitFor(`document.querySelector('input[aria-label="程序参数"]')?.value==='--profile=dev'`);
    await waitFor(`document.querySelector('[aria-label="项目运行 JDK"]')?.textContent.includes('21.0.3')`);
    await evaluate(`document.querySelector('[aria-label="运行配置启动入口"]').click()`);
    await waitFor(`!!document.querySelector('[role="listbox"]')`);
    await evaluate(`document.querySelector('[role="option"]').focus();document.querySelector('[role="option"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await waitFor(`!document.querySelector('[role="listbox"]')`);
    assert.ok(await evaluate(`!!document.querySelector('[data-java-run-modal]')`));
    await evaluate(`document.querySelector('[aria-label="关闭运行配置"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await waitFor(`!document.querySelector('[data-java-run-modal]')`);
    console.log('Java run configuration UI passed: class/module labels, wrapped full names, wide dropdown, modal without console, persistence, focus restoration and Escape nesting.');
  } catch (error) { code = 1; console.error(error.stack); }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); fs.rmSync(directory, { recursive: true, force: true }); app.exit(code); }
});
