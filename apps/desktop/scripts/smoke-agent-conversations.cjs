const { app, BrowserWindow } = require('electron');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), assert=require('node:assert/strict');
const {createLocalApi}=require('../src/local-api.cjs');
let api, window, directory; app.on('window-all-closed',()=>{});
const deadline=setTimeout(()=>{console.error('Conversation UI timed out');app.exit(1);},120000);
const evaluate=expression=>window.webContents.executeJavaScript(expression);
async function wait(expression){for(let i=0;i<250;i++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(`Not reached: ${expression}`);}
app.whenReady().then(async()=>{
  let code=0;
  try{
    directory=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-ui-'));const root=path.join(directory,'Conversation fixture');fs.mkdirSync(root);
    const command=path.join(directory,'fake-claude');fs.copyFileSync(path.join(__dirname,'../test/fixtures/agent-session-cli.cjs'),command);fs.chmodSync(command,0o700);
    const create=()=>createLocalApi({staticDir:path.join(__dirname,'../renderer'),storePath:path.join(directory,'store.sqlite3'),agentCommands:{'claude-code':command}});
    const open=async()=>{window=new BrowserWindow({show:false,width:1450,height:950,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:`conversations-${Date.now()}`}});await window.loadURL(api.origin);await wait(`[...document.querySelectorAll('button h2')].some(n=>n.textContent==='Conversation fixture')`);await evaluate(`[...document.querySelectorAll('button h2')].find(n=>n.textContent==='Conversation fixture').closest('button').click()`);await wait(`!!document.querySelector('textarea[placeholder="向智能体描述你的任务…"]') && !!document.querySelector('button[aria-label="新建项目对话"]:not(:disabled)')`);};
    const send=async(prompt,answer)=>{await evaluate(`(()=>{const node=document.querySelector('textarea[placeholder="向智能体描述你的任务…"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,${JSON.stringify(prompt)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(`[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='发送'&&!button.disabled)`);await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='发送').click()`);await wait(`document.body.innerText.includes(${JSON.stringify(answer)}) && !!document.querySelector('button[aria-label="新建项目对话"]:not(:disabled)')`);};
    api=await create();api.registerWorkspace(root);
    const response=await fetch(`${api.origin}/api/local/models`,{method:'POST',headers:{Authorization:`Bearer ${api.token}`,'Content-Type':'application/json'},body:JSON.stringify({name:'Offline Claude fixture',engine:'claude-code',provider:'fixture',model:'fixture'})});assert.equal(response.status,201);
    await open();await send('Remember token blue-sky','remembered:blue-sky');await send('What token?','What token?');
    const runs=()=>JSON.parse(fs.readFileSync(path.join(root,'.fixture-agent-sessions.json'),'utf8')).runs;
    await wait(`!document.body.innerText.includes('Working (')`);assert.ok(runs()[1].args.includes('--resume'));
    await evaluate(`document.querySelector('button[aria-label="新建项目对话"]').click()`);await wait(`!document.body.innerText.includes('Remember token blue-sky') && !!document.querySelector('button[aria-label="新建项目对话"]:not(:disabled)')`);
    await send('Fresh question','remembered:none');assert.ok(!runs()[2].args.includes('--resume'));
    window.destroy();await api.close();api=await create();api.registerWorkspace(root);await open();await wait(`document.body.innerText.includes('Fresh question') && document.body.innerText.includes('remembered:none')`);
    await evaluate(`document.querySelector('[aria-label="项目会话"]').click()`);await wait(`[...document.querySelectorAll('[role="option"]')].some(n=>n.textContent.includes('Remember token blue-sky'))`);await evaluate(`[...document.querySelectorAll('[role="option"]')].find(n=>n.textContent.includes('Remember token blue-sky')).click()`);await wait(`document.body.innerText.includes('What token?') && document.body.innerText.includes('remembered:blue-sky')`);
    await send('After restart token?','After restart token?');await wait(`!document.body.innerText.includes('Working (')`);assert.ok(runs()[3].args.includes('--resume'));assert.equal(runs()[3].args[runs()[3].args.indexOf('--resume')+1],runs()[1].args[runs()[1].args.indexOf('--resume')+1]);
    console.log('Conversation UI passed: sequential turns, native resume ID, fresh chat isolation, process/database restart, old conversation selection and resumed follow-up. Offline fixture only; no real model calls.');
  }catch(error){console.error(error);if(window&&!window.isDestroyed())console.error((await evaluate('document.body.innerText')).slice(-1800));code=1;}
  finally{clearTimeout(deadline);window?.destroy();await api?.close();if(directory)fs.rmSync(directory,{recursive:true,force:true});app.exit(code);}
});
