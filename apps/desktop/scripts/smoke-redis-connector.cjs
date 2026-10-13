const { app, BrowserWindow } = require('electron'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { createLocalApi } = require('../src/local-api.cjs'); const { LocalStore } = require('../src/local-store.cjs');
let api, window, directory; const calls = []; const remoteCalls = []; const mutations = []; const values = new Map(); const hashes = new Map([['small-field','hash-value'],['large-field','large']]); let redisTtl = 5000; let stringDeleted = false;
const setMembers = new Set(['first-set-member']); const zsetMembers = new Map([['scored-member', '1.5']]);
const listValues = ['first-list-value', ...Array.from({length:24}, (_,i)=>`list-${i}`), 'next-list-value', ...Array.from({length:4}, (_,i)=>`tail-${i}`)];
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Redis UI timed out'); app.exit(1); }, 60000);
const evaluate = expression => window.webContents.executeJavaScript(expression);
async function waitFor(expression) { for (let i = 0; i < 150; i++) { if (await evaluate(`(() => { try { return (${expression}); } catch { return false; } })()`)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('UI condition not reached: ' + expression); }
const field = label => `[...document.querySelectorAll('label')].find(node => node.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input')`;
async function input(label, value) { await evaluate(`(() => { const node = ${field(label)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)}); node.dispatchEvent(new Event('input',{bubbles:true})); })()`); }
const rawInput = (selector,value,kind='HTMLInputElement') => evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${kind}.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
async function command(text) { await evaluate(`(() => { const view = document.querySelector('.cm-content').cmTile.root.view; view.dispatch({changes:{from:0,to:view.state.doc.length,insert:${JSON.stringify(text)}}}); })()`); }
const executeButton = `[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '执行查询')`;
app.whenReady().then(async () => {
  let code = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-redis-ui-')); const storePath = path.join(directory, 'store.sqlite3');
    const codec = { available: () => true, encrypt: value => Buffer.from('protected:' + value).toString('base64'), decrypt: value => Buffer.from(value,'base64').toString().slice(10) };
    const id = '123456789012345678901234'; const store = new LocalStore(storePath);
    store.upsertConnector({ id, name: 'Redis fixture', type: 'redis', settings: { host: 'localhost', port: 6379, db: 0, username: 'acl-user', ssl: false } }, codec.encrypt('redis-secret')); store.close();
    api = await createLocalApi({ staticDir: path.join(__dirname, '../renderer'), storePath, credentialCodec: codec, connectorRuntime: { async explore(config, secret, payload) {
      assert.equal(config.settings.db, 3); assert.equal(secret,'redis-secret'); assert.equal(payload.readOnly,false);
      if (payload.redisMutation) {
        await payload.authorizeRedisMutation(); const change=payload.redisMutation; mutations.push(change);
        if (change.action.startsWith('list-')) { assert.equal(change.expectedLength,listValues.length); if (change.action === 'list-push') { if(change.side==='left')listValues.unshift(change.value);else listValues.push(change.value); } else { assert.equal(change.expectedVersion,require('node:crypto').createHash('sha256').update(listValues[change.index]).digest('hex')); if(change.action==='list-delete')listValues.splice(change.index,1);else listValues[change.index]=change.value; } }
        else if (change.action.startsWith('set-')) { if (change.action === 'set-create') setMembers.add(change.member); else setMembers.delete(change.member); }
        else if (change.action.startsWith('zset-')) { if (change.action !== 'zset-create') assert.equal(change.expectedScore, zsetMembers.get(change.member)); if (change.action === 'zset-delete') zsetMembers.delete(change.member); else zsetMembers.set(change.member, change.score); }
        else if(change.action.startsWith('hash-')){if(change.action!=='hash-create')assert.equal(change.expectedVersion,require('node:crypto').createHash('sha256').update(hashes.get(change.field)).digest('hex'));if(change.action==='hash-delete')hashes.delete(change.field);else hashes.set(change.field,change.value);}
        else if(change.action==='create'||change.action==='edit'){ if(change.action==='edit')assert.equal(change.expectedVersion,require('node:crypto').createHash('sha256').update(values.get(change.key)).digest('hex')); values.set(change.key,change.value); } else if (change.action === 'delete') stringDeleted = true; else redisTtl = change.action === 'persist' ? -1 : change.seconds * 1000;
        return { changed: true, action: change.action };
      }
      if (payload.redisBrowse) {
        const input = payload.redisBrowse;
        if (input.action === 'scan') return { cursor: '0', items: ['string key','hash key','list key','set key','zset key',...values.keys()].filter(key=>!stringDeleted||key!=='string key').map(key => ({ key, keyEncoding: 'utf8', bytes: key.length })), partial: false };
        if(values.has(input.key)){const value=values.get(input.key);return{type:'string',ttlMs:-1,exists:true,size:value.length,supported:true,value,encoding:'utf8',bytes:value.length,offset:0,nextOffset:value.length,hasMore:false,truncated:false,version:require('node:crypto').createHash('sha256').update(value).digest('hex')};}
        if (input.key !== 'string key') {
          const type = input.key.split(' ')[0];
          const named = value => ({ name: { value, encoding: 'utf8', bytes: value.length }, nameBytes: value.length, reference: { value, encoding: 'utf8', bytes: value.length } });
          const items = type === 'hash' ? [...hashes].map(([field,value])=>field==='large-field'?{...named(field),value:null,valueBytes:100000,truncated:true}:{...named(field),value:{value,encoding:'utf8',bytes:value.length},valueBytes:value.length,version:require('node:crypto').createHash('sha256').update(value).digest('hex')}) : type === 'list' ? listValues.slice(input.offset||0,(input.offset||0)+25).map((value,index)=>({index:(input.offset||0)+index,value:{value,encoding:'utf8',bytes:value.length},valueBytes:value.length,version:require('node:crypto').createHash('sha256').update(value).digest('hex')})) : type === 'set' ? (input.scanOffset ? [named('next-set-member')] : [...setMembers].map(named)) : [...zsetMembers].map(([member,score])=>({...named(member),score}));
          return { type, ttlMs: -1, exists: true, size: type==='list'?listValues.length:30, supported: true, pageKind: 'collection', items, offset: input.offset || 0, nextOffset: (input.offset||0)+items.length, cursor: '0', pageCursor: '0', scanOffset: input.scanOffset || 0, nextScanOffset: 25, count: 25, hasMore: type === 'set' ? !input.scanOffset : type === 'list' ? (input.offset||0)+items.length<listValues.length : false, partial: type === 'hash' };
        }
        return { type: 'string', ttlMs: redisTtl, exists: true, size: 32768, supported: true, value: (input.offset ? 'browser-page-two' : 'browser-page-one') + 'x'.repeat(16368), encoding: 'utf8', bytes: 16384, offset: input.offset || 0, nextOffset: (input.offset || 0) + 16384, hasMore: !input.offset, truncated: true };
      }
      calls.push(payload); return payload.command[0] === 'SET' ? 'OK' : 0;
    } } });
    window = new BrowserWindow({ show: false, width: 1440, height: 950, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `redis-${Date.now()}` } });
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => { if (/\/db-query\/|\/admin\/datasources/.test(details.url)) remoteCalls.push(details.url); callback({ cancel:false }); });
    await window.loadURL(api.origin); await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '数据源')`);
    await evaluate(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '数据源').click()`);
    await waitFor(`document.querySelector('button[aria-label="编辑连接 Redis fixture"]')`);
    await evaluate(`document.querySelector('button[aria-label="编辑连接 Redis fixture"]').click()`);
    await waitFor(`Boolean(${field('数据库编号（默认 0）')})`); assert.equal(await evaluate(`${field('数据库编号（默认 0）')}.value`),'0');
    assert.equal(await evaluate(`${field('密码（可选）')}.value`),''); assert.equal(await evaluate(`document.body.textContent.includes('redis-secret')`),false);
    await input('数据库编号（默认 0）','3'); await evaluate(`[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='保存修改').click()`);
    await waitFor(`!${field('数据库编号（默认 0）')}`);
    await evaluate(`[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='Redis fixture').click()`);
    await waitFor(`document.querySelector('.cm-content') && document.body.textContent.includes('支持 GET、SET')`);
    await waitFor(`document.querySelector('[data-redis-key]')?.textContent === 'string key'`);
    await evaluate(`document.querySelector('[data-redis-key]').click()`);
    await waitFor(`document.querySelector('[data-redis-value]')?.textContent.includes('browser-page-one')`);
    assert.equal(await evaluate(`document.querySelector('[data-redis-browser]').textContent.includes('5000 ms')`), true);
    await evaluate(`[...document.querySelectorAll('[data-redis-browser] button')].find(button => button.textContent.trim() === '下一段').click()`);
    await waitFor(`document.querySelector('[data-redis-value]')?.textContent.includes('browser-page-two')`);
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-redis-browser] button')].find(button => button.textContent.trim() === '下一段').disabled`), true);
    await evaluate(`window.confirm=()=>false; [...document.querySelectorAll('[data-redis-mutations] button')].find(button=>button.textContent==='删除键').click()`); assert.equal(mutations.length,0);
    await evaluate(`window.confirm=()=>true; [...document.querySelectorAll('[data-redis-mutations] button')].find(button=>button.textContent==='设置 TTL').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('3600000 ms')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-mutations] button')].find(button=>button.textContent==='永久保存').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('TTL：永久')`);
    const selectKey = key => evaluate(`[...document.querySelectorAll('[data-redis-key]')].find(node=>node.textContent===${JSON.stringify(key)}).click()`);
    await selectKey('hash key'); await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('hash-value')`);
    assert.equal(await evaluate(`document.querySelector('[data-redis-browser]').textContent.includes('大字段未下载')`),true);
    await evaluate(`[...document.querySelectorAll('[data-redis-mutations] button')].find(button=>button.textContent==='新增字段').click()`);
    await rawInput('[aria-label="Redis 哈希字段"]','new-field'); await rawInput('[aria-label="Redis 值内容"]','new-field-value','HTMLTextAreaElement');
    await evaluate(`[...document.querySelectorAll('[data-redis-value-editor] button')].find(button=>button.textContent==='保存值').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('new-field-value') && !document.querySelector('[data-redis-value-editor]')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-collection-row]')].find(row=>row.textContent.includes('new-field')).querySelector('button').click()`);
    await rawInput('[aria-label="Redis 值内容"]','edited-field-value','HTMLTextAreaElement');
    await evaluate(`[...document.querySelectorAll('[data-redis-value-editor] button')].find(button=>button.textContent==='保存值').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('edited-field-value') && !document.querySelector('[data-redis-value-editor]')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-collection-row]')].find(row=>row.textContent.includes('new-field')).querySelectorAll('button')[1].click()`);
    await waitFor(`![...document.querySelectorAll('[data-redis-collection-row]')].some(row=>row.textContent.includes('new-field'))`);
    await selectKey('list key'); await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('first-list-value')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-browser] button')].find(button=>button.textContent.trim()==='下一页').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('next-list-value')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-collection-row]')].find(row=>row.textContent.includes('next-list-value')).querySelector('button').click()`);
    await rawInput('[aria-label="Redis 值内容"]','edited-list-value','HTMLTextAreaElement');
    await evaluate(`[...document.querySelectorAll('[data-redis-value-editor] button')].find(button=>button.textContent==='保存值').click()`);
    await waitFor(`!document.querySelector('[data-redis-value-editor]')`); assert.equal(listValues[25],'edited-list-value');
    await evaluate(`[...document.querySelectorAll('[data-redis-browser] button')].find(button=>button.textContent.trim()==='下一页').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('edited-list-value')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-collection-row]')].find(row=>row.textContent.includes('edited-list-value')).querySelectorAll('button')[1].click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('first-list-value')`); assert.equal(listValues.length,29); assert.equal(listValues[25],'tail-0');
    await evaluate(`[...document.querySelectorAll('[data-redis-mutations] button')].find(button=>button.textContent==='新增列表项').click()`);
    await rawInput('[aria-label="Redis 值内容"]','new-list-value','HTMLTextAreaElement');
    await evaluate(`[...document.querySelectorAll('[data-redis-value-editor] button')].find(button=>button.textContent==='从尾部新增').click()`);
    await waitFor(`[...document.querySelectorAll('[role="option"]')].some(node=>node.textContent==='从头部新增')`);
    await evaluate(`[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent==='从头部新增').click()`);
    await evaluate(`[...document.querySelectorAll('[data-redis-value-editor] button')].find(button=>button.textContent==='保存值').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('new-list-value') && !document.querySelector('[data-redis-value-editor]')`); assert.equal(listValues[0],'new-list-value');
    await selectKey('set key'); await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('first-set-member')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-browser] button')].find(button=>button.textContent.trim()==='下一页').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('next-set-member')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-mutations] button')].find(button=>button.textContent==='新增成员').click()`);
    await rawInput('[aria-label="Redis 成员内容"]','new-set-member','HTMLTextAreaElement');
    await evaluate(`[...document.querySelectorAll('[data-redis-value-editor] button')].find(button=>button.textContent==='保存值').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('new-set-member') && !document.querySelector('[data-redis-value-editor]')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-collection-row]')].find(row=>row.textContent.includes('new-set-member')).querySelector('button').click()`);
    await waitFor(`![...document.querySelectorAll('[data-redis-collection-row]')].some(row=>row.textContent.includes('new-set-member'))`);
    await selectKey('zset key'); await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('scored-member')`);
    assert.equal(await evaluate(`document.querySelector('[data-redis-collection-row]').textContent.includes('1.5')`),true);
    await evaluate(`[...document.querySelectorAll('[data-redis-mutations] button')].find(button=>button.textContent==='新增成员').click()`);
    await rawInput('[aria-label="Redis 成员内容"]','new-zset-member','HTMLTextAreaElement'); await rawInput('[aria-label="Redis 成员分数"]','2.5');
    await evaluate(`[...document.querySelectorAll('[data-redis-value-editor] button')].find(button=>button.textContent==='保存值').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('new-zset-member') && !document.querySelector('[data-redis-value-editor]')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-collection-row]')].find(row=>row.textContent.includes('new-zset-member')).querySelector('button').click()`);
    await rawInput('[aria-label="Redis 成员分数"]','-3.5');
    await evaluate(`[...document.querySelectorAll('[data-redis-value-editor] button')].find(button=>button.textContent==='保存值').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]').textContent.includes('-3.5') && !document.querySelector('[data-redis-value-editor]')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-collection-row]')].find(row=>row.textContent.includes('new-zset-member')).querySelectorAll('button')[1].click()`);
    await waitFor(`![...document.querySelectorAll('[data-redis-collection-row]')].some(row=>row.textContent.includes('new-zset-member'))`);
    await selectKey('string key'); await waitFor(`!!document.querySelector('[data-redis-mutations]')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-mutations] button')].find(button=>button.textContent==='删除键').click()`);
    await waitFor(`![...document.querySelectorAll('[data-redis-key]')].some(node=>node.textContent==='string key') && !document.querySelector('[data-redis-mutations]')`);
    assert.deepEqual(mutations.map(input=>input.action),['expire','persist','hash-create','hash-edit','hash-delete','list-edit','list-delete','list-push','set-create','set-delete','zset-create','zset-edit','zset-delete','delete']);
    await command('SET "a key" "a value"'); await evaluate(`${executeButton}.click()`);
    await waitFor(`document.querySelector('.workspace-frame main pre')?.textContent.includes('OK')`); assert.deepEqual(calls[0].command,['SET','a key','a value']);
    await command('DEL "a key"'); await evaluate(`window.confirm=()=>false; ${executeButton}.click()`); assert.equal(calls.length,1);
    await evaluate(`window.confirm=()=>true; ${executeButton}.click()`);
    await waitFor(`document.querySelector('.workspace-frame main pre')?.textContent.includes('0')`); assert.equal(calls[1].confirmDestructive,true); assert.deepEqual(remoteCalls,[]);
    await evaluate(`[...document.querySelectorAll('[data-redis-browser] button')].find(button=>button.textContent==='新增键').click()`);
    const enter = (selector,value,kind='HTMLInputElement') => evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${kind}.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await enter('[aria-label="Redis 新键名称"]','new-ui-key'); await enter('[aria-label="Redis 值内容"]','new value','HTMLTextAreaElement');
    await waitFor(`(() => {const detail={dirty:false};window.dispatchEvent(new CustomEvent('code-studio:quit-check',{detail}));return detail.dirty;})()`);
    await evaluate(`[...document.querySelectorAll('[data-redis-value-editor] button')].find(button=>button.textContent==='保存值').click()`);
    await waitFor(`![...document.querySelectorAll('[data-redis-value-editor]')].length && [...document.querySelectorAll('[data-redis-key]')].some(node=>node.textContent==='new-ui-key')`);
    await selectKey('new-ui-key'); await waitFor(`document.querySelector('[data-redis-value]')?.textContent==='new value'`);
    await evaluate(`[...document.querySelectorAll('[data-redis-mutations] button')].find(button=>button.textContent==='编辑值').click()`);
    await enter('[aria-label="Redis 值内容"]','edited value','HTMLTextAreaElement');
    await evaluate(`[...document.querySelectorAll('[data-redis-value-editor] button')].find(button=>button.textContent==='保存值').click()`);
    await waitFor(`!document.querySelector('[data-redis-value-editor]')`); assert.equal(values.get('new-ui-key'),'edited value');
    console.log('Redis UI passed: data-source entry, DB editing, hidden retained credential, shared detail, quoted writes, deletion confirmation and zero result; no remote API.');
  } catch(error) { code=1; console.error(error); }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if(directory) fs.rmSync(directory,{recursive:true,force:true}); app.exit(code); }
});
