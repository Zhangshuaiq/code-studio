const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { LocalStore } = require('../src/local-store.cjs');
const { LocalAgentRuntime, cliInvocation, conversationBinding } = require('../src/local-agent-runtime.cjs');
test('resume invocations use exact IDs, retain current permissions, and never select --last', () => {
  const id = crypto.randomUUID();
  for(const engine of ['codex-cli','claude-code']) {
    const invocation = cliInvocation({engine,model:'test'}, 'hello', 'read-only', {resumeId:id});
    assert.ok(invocation.args.includes(id)); assert.equal(invocation.stdin,'hello'); assert.ok(!invocation.args.includes('--last')); assert.ok(!invocation.args.includes('--continue'));
    assert.equal(invocation.args[invocation.args.indexOf(engine==='codex-cli'?'--sandbox':'--permission-mode')+1],engine==='codex-cli'?'read-only':'plan');
    assert.throws(()=>cliInvocation({engine},'test','read-only',{resumeId:'../other-session'}),/标识/);
  }
});
for(const engine of ['codex-cli','claude-code']) test(`${engine}: multi-turn resume survives restart, permission switches bootstrap safely, fresh chat and missing sessions do not silently replay`, {skip:process.platform==='win32'}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'agent-conversation-')), root = path.join(directory,'workspace'); fs.mkdirSync(root);
  const command = path.join(directory,'fixture-cli'); fs.copyFileSync(path.join(__dirname,'fixtures/agent-session-cli.cjs'),command); fs.chmodSync(command,0o700);
  const database = path.join(directory,'store.sqlite3'); let store = new LocalStore(database), runtime;
  const project={id:'project',path:fs.realpathSync(root)}, config={id:'model',engine,provider:'fixture',updatedAt:'stable'};
  const recreate = ()=>runtime=new LocalAgentRuntime({store,commands:{[engine]:command}}); recreate();
  t.after(async()=>{await runtime.shutdown();store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const conversation = store.createAgentConversation({projectId:project.id,modelConfigId:config.id,engine,bindingKey:conversationBinding(project,config)});
  const send = async(prompt,permissionProfile='read-only',conversationId=conversation.id)=>{
    const task={id:crypto.randomBytes(12).toString('hex'),projectId:project.id,modelConfigId:config.id,conversationId,prompt,permissionProfile,status:'queued',createdAt:new Date().toISOString()};
    store.createAgentTask(task); runtime.start(task,project,config); await runtime.active.get(project.id).promise; return store.getAgentTask(task.id);
  };
  const first=await send('Remember token blue-sky'); assert.equal(first.status,'succeeded'); const session=store.getAgentConversation(conversation.id).cliSessionId; assert.ok(session);
  const second=await send('What token?'); assert.equal(second.status,'succeeded'); assert.match(second.events.find(e=>e.kind==='text').text,/blue-sky/); assert.equal(store.getAgentConversation(conversation.id).cliSessionId,session);
  assert.equal(second.events.filter(e=>e.kind==='text').length,1,'Claude result must not duplicate the assistant message');
  await runtime.shutdown(); store.close(); store=new LocalStore(database); recreate();
  assert.equal((await send('After restart, what token?')).status,'succeeded'); assert.equal(store.getAgentConversation(conversation.id).cliSessionId,session);
  const modified=await send('What token with edit permission?','workspace-write'); assert.equal(modified.status,'succeeded'); assert.notEqual(store.getAgentConversation(conversation.id).cliSessionId,session); assert.match(modified.events.find(e=>e.kind==='text').text,/blue-sky/);
  const readOnly=await send('Now just inspect, what token?'); assert.equal(readOnly.status,'succeeded'); const runs=()=>JSON.parse(fs.readFileSync(path.join(root,'.fixture-agent-sessions.json'),'utf8')).runs;
  const readArgs=runs().at(-1).args; assert.ok(!readArgs.includes('resume')&&!readArgs.includes('--resume')); assert.ok(readArgs.includes(engine==='codex-cli'?'read-only':'plan'));
  const fresh=store.createAgentConversation({projectId:project.id,modelConfigId:config.id,engine,bindingKey:conversationBinding(project,config)});
  assert.match((await send('What token?','read-only',fresh.id)).events.find(e=>e.kind==='text').text,/none/);
  const otherTask={id:'wrong-project',projectId:'other',modelConfigId:config.id,conversationId:conversation.id,prompt:'test'};
  assert.throws(()=>runtime.start(otherTask,{...project,id:'other'},config),/不属于/);
  assert.throws(()=>runtime.start({...otherTask,projectId:project.id},project,{...config,updatedAt:'changed'}),/不属于/);
  store.setAgentConversationSession(conversation.id,crypto.randomUUID(),'read-only'); const before=runs().length;
  const missing=await send('Do not repeat writes'); assert.equal(missing.status,'failed'); assert.match(missing.error,/未自动重新执行/); assert.equal(runs().length,before+1);
});
test('API context includes only successful same-conversation user/assistant pairs, bounded oldest-first and persisted', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-history-')); const store=new LocalStore(path.join(directory,'store.sqlite3')); t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const create=()=>store.createAgentConversation({projectId:'p',modelConfigId:'m',engine:'openai-compatible',bindingKey:'binding'});
  const first=create(), second=create();
  for(const [id,conversationId,status,text] of [['a',first.id,'succeeded','first answer'],['b',first.id,'failed','failed answer'],['c',second.id,'succeeded','other answer'],['d',first.id,'succeeded','last answer']]) {
    store.createAgentTask({id,conversationId,projectId:'p',modelConfigId:'m',prompt:`prompt ${id}`,status,createdAt:new Date().toISOString()}); store.addAgentEvent(id,{kind:'reasoning',text:'private thinking'}); store.addAgentEvent(id,{kind:'text',text});
  }
  assert.deepEqual(store.agentConversationHistory(first.id,'current').messages.map(m=>m.content),['prompt a','first answer','prompt d','last answer']);
  const limited=store.agentConversationHistory(first.id,'current',22); assert.equal(limited.truncated,true); assert.deepEqual(limited.messages.map(m=>m.content),['prompt d','last answer']);
});
test('version 8 migration preserves legacy task history without inventing native sessions', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-migrate-')), database=path.join(directory,'store.sqlite3'); let store=new LocalStore(database);
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  store.createAgentTask({id:'legacy',projectId:'p',modelConfigId:'m',prompt:'old question',status:'succeeded',createdAt:'2026-10-01T00:00:00.000Z'}); store.addAgentEvent('legacy',{kind:'text',text:'old answer'});
  store.database.exec('DROP INDEX agent_tasks_conversation; ALTER TABLE agent_tasks DROP COLUMN conversation_id; DROP TABLE agent_conversations; PRAGMA user_version=8;');store.close();store=new LocalStore(database);
  assert.equal(store.getSchemaVersion(),9);assert.equal(store.getAgentTask('legacy').events[0].text,'old answer');assert.equal(store.getAgentTask('legacy').conversationId,null);assert.equal(store.listAgentTasks('p',50,'legacy').length,1);assert.deepEqual(store.listAgentConversations('p'),[]);
});
