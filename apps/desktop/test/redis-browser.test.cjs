const test = require('node:test'); const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const Redis = require('ioredis');
const { browseRedis, validateRedisBrowse, displayBuffer } = require('@codegen/code-intelligence/redis-browser.cjs');
test('Redis browser validates operations, cursors, byte offsets and exact binary key references', () => {
  for (const input of [{ action: 'delete' }, { action: 'scan', cursor: '-1' }, { action: 'scan', count: 101 }, { action: 'value', key: 'key', offset: -1 }, { action: 'value', key: '***', keyEncoding: 'base64' }]) assert.throws(() => validateRedisBrowse(input));
  assert.equal(validateRedisBrowse({ action: 'value', key: '', keyEncoding: 'utf8' }).key.length, 0);
  const binary = Buffer.from([0, 255, 1]); assert.deepEqual(validateRedisBrowse({ action: 'value', key: binary.toString('base64'), keyEncoding: 'base64' }).key, binary);
  assert.equal(displayBuffer(Buffer.from('你好')).encoding, 'utf8'); assert.equal(displayBuffer(binary).encoding, 'base64');
  const bomKey = Buffer.from('\ufefforiginal-key'); const bomDisplay = displayBuffer(bomKey); assert.deepEqual(Buffer.from(bomDisplay.value, 'utf8'), bomKey, 'UTF-8 BOM is part of a Redis key, not file encoding metadata');
});
test('Redis SCAN keeps binary keys intact and reports omitted oversized batches without claiming full coverage', async () => {
  const result = await browseRedis({ scanBuffer: async () => [Buffer.from('0'), [Buffer.from('plain'), Buffer.from([255, 0]), Buffer.alloc(8193)]] }, { action: 'scan' });
  assert.equal(result.items[0].key, 'plain'); assert.equal(result.items[1].keyEncoding, 'base64'); assert.equal(result.omitted, 1); assert.equal(result.partial, true); assert.equal(result.complete, false);
});
test('Redis collection metadata does not load unbounded values and expired keys are explicit', async () => {
  const client = { type: async () => 'hash', pttl: async () => -1, callBuffer: async () => { throw new Error('NOPERM no scripting'); }, call: async (command, key) => { assert.equal(command, 'HLEN'); assert.ok(Buffer.isBuffer(key)); return 3; } };
  const metadata = await browseRedis(client, { action: 'inspect', key: 'hash' }); assert.equal(metadata.size, 3); assert.equal(metadata.sizeUnit, 'items');
  const value = await browseRedis(client, { action: 'value', key: 'hash' }); assert.equal(value.supported, false);
  assert.deepEqual(await browseRedis({ type: async () => 'none', pttl: async () => -2 }, { action: 'value', key: 'expired' }), { type: 'none', ttlMs: -2, exists: false });
});
test('real Redis browser pages Unicode bytes losslessly, preserves binary keys and uses local configured database', { skip: process.env.RUN_REDIS_TESTS !== '1', timeout: 30000 }, async t => {
  const client = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), password: process.env.REDIS_PASSWORD || undefined, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0 }); client.on('error', () => {});
  const prefix = 'code-studio-browser-test:' + crypto.randomUUID(); const textKey = prefix + ':text'; const binaryKey = Buffer.concat([Buffer.from(prefix + ':'), Buffer.from([0,255])]);
  t.after(async () => { try { if (client.status === 'ready') await client.del(textKey, binaryKey); } finally { client.disconnect(); } });
  await client.connect(); const content = '你好'.repeat(4000); await client.set(textKey, content, 'PX', 60000); await client.set(binaryKey, Buffer.from([0,255,2]));
  const metadata = await browseRedis(client, { action: 'inspect', key: textKey }); assert.equal(metadata.type, 'string'); assert.equal(metadata.size, Buffer.byteLength(content)); assert.ok(metadata.ttlMs > 0);
  let cursor = '0'; const keys = [];
  do { const page = await browseRedis(client, { action: 'scan', match: prefix + ':*', cursor, count: 10 }); keys.push(...page.items); cursor = page.cursor; } while (cursor !== '0');
  const binaryReference = keys.find(item => item.keyEncoding === 'base64'); assert.ok(binaryReference);
  const binaryValue = await browseRedis(client, { action: 'value', key: binaryReference.key, keyEncoding: binaryReference.keyEncoding }); assert.deepEqual(Buffer.from(binaryValue.value, 'base64'), Buffer.from([0,255,2]));
  const first = await browseRedis(client, { action: 'value', key: textKey }); assert.equal(first.bytes, 16384); assert.equal(first.hasMore, true);
  const second = await browseRedis(client, { action: 'value', key: textKey, offset: first.nextOffset }); assert.equal(second.hasMore, false);
  const decode = item => Buffer.from(item.value, item.encoding === 'base64' ? 'base64' : 'utf8'); assert.equal(Buffer.concat([decode(first), decode(second)]).toString(), content);
});
