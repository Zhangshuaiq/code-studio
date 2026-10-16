const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const assert = require('node:assert/strict'); const { execFileSync } = require('node:child_process');
const { createLocalApi } = require('../src/local-api.cjs');
let window, api, directory;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Git UI smoke timed out'); app.exit(1); }, 120000);
const evaluate = expression => window.webContents.executeJavaScript(expression);
async function wait(expression) { for (let i = 0; i < 250; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error(`Not reached: ${expression}`); }
const click = text => evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`);
app.whenReady().then(async () => {
  let exit = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-multi-pane-ui-')); const root = path.join(directory, 'Git fixture'); fs.mkdirSync(root);
    const git = (...args) => execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args], {cwd:root,encoding:'utf8'}).trim();
    git('init','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(root,'file.txt'),'start\nbase\nend\n'); git('add','.'); git('commit','-m','base');
    git('checkout','-b','feature'); fs.writeFileSync(path.join(root,'file.txt'),'start\ntheirs\nend\n'); git('commit','-am','theirs'); git('checkout','main');
    fs.writeFileSync(path.join(root,'file.txt'),'start\nours\nend\n'); git('commit','-am','ours'); const head = git('rev-parse','HEAD');
    fs.appendFileSync(path.join(root,'file.txt'),'working\n');
    api = await createLocalApi({staticDir:path.join(__dirname,'../renderer'),storePath:path.join(directory,'store.sqlite3')}); const project = api.registerWorkspace(root);
    window = new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:`git-test-${Date.now()}`}});
    window.webContents.on('console-message', (_event, details) => { if(details?.level === 'error') console.error('Renderer:', details.message); });
    await window.loadURL(api.origin); await wait(`[...document.querySelectorAll('button h2')].some(n=>n.textContent==='Git fixture')`);
    await evaluate(`[...document.querySelectorAll('button h2')].find(n=>n.textContent==='Git fixture').closest('button').click()`);
    await wait(`[...document.querySelectorAll('button')].some(n=>n.textContent.startsWith('分支 / 变更'))`);
    await evaluate(`[...document.querySelectorAll('button')].find(n=>n.textContent.startsWith('分支 / 变更')).click()`);
    await wait(`!!document.querySelector('button[title="查看差异"]')`); await evaluate(`document.querySelector('button[title="查看差异"]').click()`);
    await wait(`!!document.querySelector('[data-code-diff-view] .monaco-diff-editor')`);
    await evaluate(`new Promise(resolve=>window.require(['vs/editor/editor.main'],mod=>{window.__m=window.monaco||mod;resolve();}))`);
    await wait(`window.__m.editor.getDiffEditors().some(editor=>editor.getLineChanges()?.length)`);
    assert.equal(await evaluate(`document.querySelectorAll('[data-code-diff-view] .monaco-editor').length >= 2`),true);
    await wait(`!!document.querySelector('[aria-label="将当前差异从左侧应用到右侧"]:not(:disabled)')`);
    await evaluate(`document.querySelector('[aria-label="将当前差异从左侧应用到右侧"]').click()`);
    await wait(`window.__m.editor.getDiffEditors().find(e=>e.getModifiedEditor().getDomNode()?.isConnected)?.getModifiedEditor().getValue()===${JSON.stringify('start\nours\nend\n')}`);
    assert.match(fs.readFileSync(path.join(root,'file.txt'),'utf8'),/working/, 'hunk arrow must not write disk');
    await evaluate(`window.__m.editor.getDiffEditors().find(e=>e.getModifiedEditor().getDomNode()?.isConnected).getModifiedEditor().trigger('test','undo',null)`);
    await wait(`window.__m.editor.getDiffEditors().find(e=>e.getModifiedEditor().getDomNode()?.isConnected)?.getModifiedEditor().getValue().includes('working')`);
    await evaluate(`document.querySelector('button[aria-label="关闭变更对比"]').click()`);
    await click('对比分支'); await wait(`!!document.querySelector('[role="dialog"][aria-label="分支对比"]')`);
    await wait(`!!document.querySelector('[data-code-diff-view] .monaco-diff-editor')`); assert.equal(git('rev-parse','HEAD'),head);
    await evaluate(`document.querySelector('button[aria-label="关闭分支对比"]').click()`);
    fs.writeFileSync(path.join(root,'file.txt'),'start\nours\nend\n');
    // Only this disposable fixture repository is merged. The UI must expose the resolver for an existing external merge too.
    const response = await fetch(`${api.origin}/api/local/projects/${project.id}/git/merge`,{method:'POST',headers:{Authorization:`Bearer ${api.token}`,'Content-Type':'application/json'},body:JSON.stringify({branch:'feature'})}); assert.equal(response.status,200);
    await evaluate(`document.querySelector('button[title="刷新 Git 状态"]').click()`); await wait(`[...document.querySelectorAll('button')].some(n=>n.textContent==='解决冲突 / 完成合并')`); await click('解决冲突 / 完成合并');
    await wait(`document.querySelectorAll('.monaco-editor').length>=3 && [...document.querySelectorAll('button')].some(n=>n.title==='当前冲突块两边都保留')`);
    await evaluate(`document.querySelector('button[title="当前冲突块两边都保留"]').click()`);
    await wait(`window.__m.editor.getEditors().some(e=>e.getModel()?.getValue()===${JSON.stringify('start\nours\ntheirs\nend\n')})`);
    await evaluate(`[...document.querySelector('[aria-label="可视化解决 Git 合并冲突"]').querySelectorAll('button')].find(button=>button.textContent.trim()==='保存').click()`); await wait(`[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='完成合并')`);
    assert.match(fs.readFileSync(path.join(root,'file.txt'),'utf8'),/ours\ntheirs/); assert.equal(git('diff','--name-only','--diff-filter=U'),'');
    console.log('Git UI passed: real two-pane hunk arrow, undo without disk writes, branch comparison without checkout, shared three-pane conflict both/save.');
  } catch(error) { console.error(error); if(window&&!window.isDestroyed())console.error((await evaluate(`document.body.innerText`)).slice(-1800)); exit=1; }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if(directory)fs.rmSync(directory,{recursive:true,force:true}); app.exit(exit); }
});
