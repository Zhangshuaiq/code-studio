const test = require('node:test'); const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const Redis = require('ioredis');
const { LocalConnectorRuntime } = require('../src/local-connector-runtime.cjs');
const { validateRedisMutation } = require('../src/redis-mutation.cjs');
const { browseRedis } = require('@codegen/code-intelligence/redis-browser.cjs');
test('Redis value edits require full-version tokens and enforce encoded byte limits', () => {
  const base = { action:'edit', key:'key', confirm:true, value:'value' };
  assert.throws(()=>validateRedisMutation(base,false),/完整值版本/);
  assert.throws(()=>validateRedisMutation({...base,expectedVersion:'a'.repeat(64),value:'你'.repeat(6000)},false),/16 KiB/);
  assert.throws(()=>validateRedisMutation({action:'create',key:'key',confirm:true,value:'bad!',valueEncoding:'base64'},false),/Base64/);
});
test('real Redis creation never overwrites and edits preserve TTL, binary bytes and concurrent changes', {skip:process.env.RUN_REDIS_TESTS!=='1',timeout:30000}, async t => {
  const settings={host:process.env.REDIS_HOST||'127.0.0.1',port:Number(process.env.REDIS_PORT||6379),db:0}; const secret=process.env.REDIS_PASSWORD||'';
  const client=new Redis({...settings,password:secret||undefined,lazyConnect:true,retryStrategy:()=>null,maxRetriesPerRequest:0}); client.on('error',()=>{});
  const key='code-studio-value-edit:'+crypto.randomUUID(); t.after(async()=>{try{if(client.status==='ready')await client.del(key);}finally{client.disconnect();}}); await client.connect();
  const runtime=new LocalConnectorRuntime(); const config={type:'redis',settings};
  const change=(action,extra={})=>runtime.explore(config,secret,{readOnly:false,redisMutation:{key,confirm:true,...action},...extra});
  assert.equal((await change({action:'create',value:'initial'})).changed,true);
  await assert.rejects(change({action:'create',value:'must-not-overwrite'}),/已存在/); assert.equal(await client.get(key),'initial');
  await client.expire(key,60); const first=await browseRedis(client,{action:'value',key}); assert.ok(first.version);
  assert.equal((await change({action:'edit',value:'edited',expectedVersion:first.version})).changed,true); assert.ok(await client.ttl(key)>0);
  await assert.rejects(change({action:'edit',value:'stale',expectedVersion:first.version}),/已被修改/); assert.equal(await client.get(key),'edited');
  const second=await browseRedis(client,{action:'value',key}); let checks=0;
  await assert.rejects(change({action:'edit',value:'must-not-overwrite',expectedVersion:second.version},{authorizeRedisMutation:async()=>{if(++checks===2)await client.set(key,'concurrent');}}),/发生变化/);
  assert.equal(await client.get(key),'concurrent');
  const current=await browseRedis(client,{action:'value',key}); const binary=Buffer.from([0,255,2]); await change({action:'edit',expectedVersion:current.version,value:binary.toString('base64'),valueEncoding:'base64'}); assert.deepEqual(await client.getBuffer(key),binary);
  await client.set(key,'x'.repeat(20000)); const preview=await browseRedis(client,{action:'value',key}); assert.equal(preview.version,undefined); assert.equal(preview.truncated,true);
});
