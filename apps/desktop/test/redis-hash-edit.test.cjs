const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');const Redis=require('ioredis');
const {LocalConnectorRuntime}=require('../src/local-connector-runtime.cjs');const {browseRedis}=require('@codegen/code-intelligence/redis-browser.cjs');const {validateRedisMutation}=require('../src/redis-mutation.cjs');
test('hash edits require exact field encoding and complete version tokens',()=>{
  assert.throws(()=>validateRedisMutation({action:'hash-edit',key:'key',field:'field',value:'value',confirm:true},false),/完整值版本/);
  assert.throws(()=>validateRedisMutation({action:'hash-create',key:'key',field:'bad!',fieldEncoding:'base64',value:'value',confirm:true},false),/编码/);
});
test('real Redis hash CRUD rejects duplicate/stale/concurrent writes and preserves TTL and binary fields',{skip:process.env.RUN_REDIS_TESTS!=='1',timeout:30000},async t=>{
  const settings={host:process.env.REDIS_HOST||'127.0.0.1',port:Number(process.env.REDIS_PORT||6379),db:0};const secret=process.env.REDIS_PASSWORD||'';
  const client=new Redis({...settings,password:secret||undefined,lazyConnect:true,retryStrategy:()=>null,maxRetriesPerRequest:0});client.on('error',()=>{});
  const key='code-studio-hash-edit:'+crypto.randomUUID();t.after(async()=>{try{if(client.status==='ready')await client.del(key);}finally{client.disconnect();}});await client.connect();await client.hset(key,'seed','initial');await client.expire(key,60);
  const runtime=new LocalConnectorRuntime();const change=(input,extra={})=>runtime.explore({type:'redis',settings},secret,{readOnly:false,redisMutation:{key,confirm:true,...input},...extra});
  await change({action:'hash-create',field:'new-field',value:'first'});await assert.rejects(change({action:'hash-create',field:'new-field',value:'bad'}),/已存在/);
  const page=await browseRedis(client,{action:'value',key});const row=page.items.find(item=>item.name.value==='new-field');assert.ok(row.version);
  await change({action:'hash-edit',field:'new-field',value:'edited',expectedVersion:row.version});assert.equal(await client.hget(key,'new-field'),'edited');assert.ok(await client.ttl(key)>0);
  await assert.rejects(change({action:'hash-delete',field:'new-field',expectedVersion:row.version}),/改变/);
  const current=(await browseRedis(client,{action:'value',key})).items.find(item=>item.name.value==='new-field');let checks=0;
  await assert.rejects(change({action:'hash-edit',field:'new-field',value:'bad',expectedVersion:current.version},{authorizeRedisMutation:async()=>{if(++checks===2)await client.hset(key,'new-field','concurrent');}}),/并发/);assert.equal(await client.hget(key,'new-field'),'concurrent');
  const field=Buffer.from([0,255]);await change({action:'hash-create',field:field.toString('base64'),fieldEncoding:'base64',value:'binary'});
  const binary=(await browseRedis(client,{action:'value',key})).items.find(item=>item.reference?.encoding==='base64');assert.ok(binary);
  await change({action:'hash-delete',field:binary.reference.value,fieldEncoding:binary.reference.encoding,expectedVersion:binary.version});assert.equal(await client.hexists(key,field),0);
});
