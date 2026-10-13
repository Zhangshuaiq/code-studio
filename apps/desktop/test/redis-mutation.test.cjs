const test = require('node:test'); const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const Redis = require('ioredis');
const { validateRedisMutation, mutateRedis } = require('../src/redis-mutation.cjs');
const { LocalConnectorRuntime } = require('../src/local-connector-runtime.cjs');
test('typed Redis mutations require write authority, confirmation, safe TTL and exact key encoding', () => {
  const input = { action: 'delete', key: 'key', confirm: true };
  assert.throws(() => validateRedisMutation(input, true), /只读/); assert.throws(() => validateRedisMutation({ ...input, confirm: false }, false), /确认/);
  for (const seconds of [0, -1, 1.2, 2147483648]) assert.throws(() => validateRedisMutation({ action: 'expire', key: 'key', confirm: true, seconds }, false));
  assert.deepEqual(validateRedisMutation({ ...input, key: 'AP8=', keyEncoding: 'base64' }, false).key, Buffer.from([0,255]));
});
test('Redis mutation type precheck fails without issuing a write', async () => {
  const result = validateRedisMutation({ action: 'delete', key: 'key', confirm: true, expectedType: 'string' }, false);
  await assert.rejects(mutateRedis({ type: async () => 'hash', unlink: () => { throw Error('must not write'); } }, result), /类型/);
  await assert.rejects(mutateRedis({ type: async () => 'string', unlink: () => { throw Error('must not write'); } }, result, () => { throw Error('revoked after type lookup'); }), /revoked after type lookup/);
});
test('real typed Redis TTL, persist and binary-key delete recheck authority before writes', { skip: process.env.RUN_REDIS_TESTS !== '1', timeout: 30000 }, async t => {
  const settings = { host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), db: 0 }; const secret = process.env.REDIS_PASSWORD || '';
  const client = new Redis({ ...settings, password: secret || undefined, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0 }); client.on('error', () => {});
  const key = Buffer.concat([Buffer.from('code-studio-mutation:' + crypto.randomUUID()),Buffer.from([0,255])]);
  t.after(async () => { try { if(client.status==='ready')await client.del(key); } finally { client.disconnect(); } }); await client.connect(); await client.set(key,'fixture');
  const runtime = new LocalConnectorRuntime(); const config = { type:'redis', settings }; let checks = 0;
  const apply = action => runtime.explore(config,secret,{readOnly:false,redisMutation:{key:key.toString('base64'),keyEncoding:'base64',confirm:true,expectedType:'string',...action},authorizeRedisMutation:()=>{checks++;}});
  assert.equal((await apply({action:'expire',seconds:60})).changed,true); assert.ok(await client.ttl(key)>0);
  assert.equal((await apply({action:'persist'})).changed,true); assert.equal(await client.ttl(key),-1);
  await assert.rejects(runtime.explore(config,secret,{readOnly:false,redisMutation:{action:'delete',key:key.toString('base64'),keyEncoding:'base64',confirm:true},authorizeRedisMutation:()=>{throw Error('authority revoked');}}),/authority revoked/);
  assert.equal(await client.exists(key),1);
  assert.equal((await apply({action:'delete'})).changed,true); assert.equal(await client.exists(key),0); assert.equal(checks,6);
});
