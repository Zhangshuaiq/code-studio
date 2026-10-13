const test = require('node:test'); const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const Redis = require('ioredis');
const { browseRedis, validateRedisBrowse } = require('@codegen/code-intelligence/redis-browser.cjs');
const { collectionPage } = require('@codegen/code-intelligence/redis-collection.cjs');
test('collection paging rejects invalid cursors and offsets and never falls back to writable EVAL', async () => {
  for (const input of [{ cursor: '-1' }, { count: 0 }, { scanOffset: -1 }, { scanOffset: 1000001 }]) assert.throws(() => validateRedisBrowse({ action: 'value', key: 'key', ...input }));
  const calls = [];
  const result = await collectionPage({ async callBuffer(command, script, numkeys) { calls.push(command); assert.equal(numkeys, 1); assert.ok(script.includes('HSCAN')); throw new Error('NOPERM script'); } }, { key: Buffer.from('key'), cursor: '0', scanOffset: 0, count: 25, offset: 0 }, 'hash', 2);
  assert.equal(result.supported, false); assert.deepEqual(calls, ['EVAL_RO']);
});
test('real Redis hash/list/set/zset paging bounds previews and preserves compact-set continuation', { skip: process.env.RUN_REDIS_TESTS !== '1', timeout: 30000 }, async t => {
  const client = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), password: process.env.REDIS_PASSWORD || undefined, lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null }); client.on('error', () => {});
  const prefix = 'code-studio-collection:' + crypto.randomUUID(); const keys = ['hash', 'list', 'set', 'zset'].map(type => prefix + ':' + type);
  t.after(async () => { try { if (client.status === 'ready') await client.del(...keys); } finally { client.disconnect(); } });
  await client.connect(); await client.hset(keys[0], 'small', 'hello', 'large', 'x'.repeat(100000), 'empty', '');
  await client.rpush(keys[1], 'first', 'z'.repeat(100000), ...Array.from({ length: 30 }, (_, i) => 'item-' + i));
  await client.sadd(keys[2], ...Array.from({ length: 100 }, (_, i) => String(i)));
  await client.zadd(keys[3], 1.5, 'member-a', 2.5, Buffer.from([0,255]));
  const read = (key, extra = {}) => browseRedis(client, { action: 'value', key, ...extra });
  const hash = await read(keys[0]); assert.equal(hash.type, 'hash'); assert.equal(hash.supported, true);
  assert.equal(hash.items.find(row => row.name.value === 'small').value.value, 'hello');
  assert.equal(hash.items.find(row => row.name.value === 'empty').value.value, '');
  const large = hash.items.find(row => row.name.value === 'large'); assert.equal(large.valueBytes, 100000); assert.equal(large.value, null); assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(hash)) < 10000, 'large hash field must not cross the client boundary');
  const list = await read(keys[1]); assert.equal(list.items.length, 25); assert.equal(list.hasMore, true); assert.equal(list.items[1].value.bytes, 1024); assert.equal(list.items[1].valueBytes, 100000); assert.equal(list.items[1].truncated, true);
  const nextList = await read(keys[1], { offset: list.nextOffset }); assert.equal(nextList.items[0].index, 25); assert.equal(nextList.hasMore, false);
  const members = []; let cursor = '0'; let scanOffset = 0; let pages = 0;
  while (true) { const page = await read(keys[2], { cursor, scanOffset }); members.push(...page.items.map(row => row.name.value)); pages++; if (!page.hasMore) break; assert.ok(pages < 20); cursor = page.cursor; scanOffset = page.nextScanOffset; }
  assert.equal(new Set(members).size, 100); assert.ok(pages >= 4, 'compact SSCAN batches must not silently lose rows above page size');
  const sorted = await read(keys[3]); assert.equal(sorted.items[0].score, '1.5'); assert.equal(sorted.items[1].name.encoding, 'base64'); assert.deepEqual(Buffer.from(sorted.items[1].reference.value, 'base64'), Buffer.from([0,255]));
  assert.equal(await client.hget(keys[0], 'small'), 'hello'); assert.equal(await client.scard(keys[2]), 100);
});
