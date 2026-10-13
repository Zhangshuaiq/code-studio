require('reflect-metadata');
const test = require('node:test'); const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const Redis = require('ioredis');
const { DbQueryService } = require('../dist/db-query/db-query.service.js');
const { ExecuteQueryDto } = require('../dist/db-query/dto/db-query.dto.js'); const { plainToInstance } = require('class-transformer'); const { validate } = require('class-validator');
test('Redis browser DTO validates nested readonly actions, bounds and rejects extra mutation fields', async () => {
  for (const input of [{ redisMutation: { action: 'delete', key: 'key', confirm: true } }, { redisBrowse: { action: 'delete', key: 'key' } }, { redisBrowse: { action: 'scan', count: 1000 } }, { redisBrowse: { action: 'value', key: 'key', write: true } }]) {
    assert.ok((await validate(plainToInstance(ExecuteQueryDto, input), { whitelist: true, forbidNonWhitelisted: true })).length > 0);
  }
  assert.equal((await validate(plainToInstance(ExecuteQueryDto, { redisBrowse: { action: 'scan', cursor: '0', match: 'test:*', count: 10 } }), { whitelist: true, forbidNonWhitelisted: true })).length, 0);
});
test('remote Redis browser requires datasource membership before any operation', async () => {
  const service = new DbQueryService({ datasource: { findFirst: async () => null } }, { decrypt: () => { throw new Error('must not decrypt'); } }, { get: () => undefined });
  await assert.rejects(service.executeQuery('data', 'unauthorized', { redisBrowse: { action: 'scan' } }), /无权访问/);
});
test('real remote Redis browser is readonly and rechecks revocation and configuration after reading', { skip: process.env.RUN_REDIS_TESTS !== '1', timeout: 30000 }, async t => {
  const config = { host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), password: process.env.REDIS_PASSWORD || undefined, db: 0 };
  const client = new Redis({ ...config, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0 }); client.on('error', () => {});
  const key = 'code-studio-api-browser:' + crypto.randomUUID(); t.after(async () => { try { if (client.status === 'ready') await client.del(key); } finally { client.disconnect(); } });
  await client.connect(); await client.set(key, 'readonly-fixture');
  let reads = 0; let behavior = 'normal';
  const service = new DbQueryService({ datasource: { findFirst: async args => {
    assert.equal(args.where.members.some.userId, 'user'); reads++;
    if (behavior === 'revoked' && reads === 2) return null;
    return { type: 'redis', encryptedConfig: JSON.stringify(behavior === 'changed' && reads === 2 ? { ...config, db: 1 } : config) };
  } } }, { decrypt: value => value }, { get: (_key, fallback) => fallback });
  const result = await service.executeQuery('data', 'user', { redisBrowse: { action: 'value', key }, command: ['SET', key, 'must-not-write'] });
  assert.equal(result.value, 'readonly-fixture'); assert.equal(reads, 2); assert.equal(await client.get(key), 'readonly-fixture');
  reads = 0; behavior = 'revoked'; await assert.rejects(service.executeQuery('data', 'user', { redisBrowse: { action: 'value', key } }), /无权访问/);
  reads = 0; behavior = 'changed'; await assert.rejects(service.executeQuery('data', 'user', { redisBrowse: { action: 'value', key } }), error => error.getStatus() === 409);
  reads = 0; behavior = 'normal'; await assert.rejects(service.executeQuery('data', 'user', { command: ['SET', key, 'must-not-write'] }), error => error.getStatus() === 403);
  assert.equal(await client.get(key), 'readonly-fixture');
});
