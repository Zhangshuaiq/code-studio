const Redis = require('ioredis');
const { validateRedisMutation, mutateRedis } = require('./redis-mutation.cjs');
const { browseRedis, validateRedisBrowse } = require('@codegen/code-intelligence/redis-browser.cjs');
const registry = require('@codegen/code-intelligence/redis-commands.json');
const READ = new Set(registry.read);
const WRITE = new Set(registry.write);
function invalid(message) { return Object.assign(new Error(message), { code: 'LOCAL_CONNECTOR_INVALID' }); }
function validateRedisCommand(value, readOnly = true) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(arg => typeof arg !== 'string' || arg.includes('\0')) || Buffer.byteLength(JSON.stringify(value)) > 64000) throw invalid('Redis 命令参数无效或超过大小限制');
  const command = value[0].toUpperCase();
  if (!READ.has(command) && !WRITE.has(command)) throw invalid(command === 'KEYS' ? '请使用 SCAN 分页浏览键，不支持 KEYS 全量扫描' : `暂不支持 Redis 命令 ${command}`);
  if (readOnly && WRITE.has(command)) throw invalid('当前工作区仅允许 Redis 只读命令');
  if (registry.destructive.includes(command)) return { command, args: value.slice(1), destructive: true };
  return { command, args: value.slice(1), destructive: false };
}
async function withRedis(settings, secret, action) {
  const client = new Redis({ host: settings.host, port: settings.port, db: settings.db || 0, username: settings.username || undefined, password: secret || undefined, tls: settings.ssl ? { rejectUnauthorized: true } : undefined, lazyConnect: true, enableOfflineQueue: false, connectTimeout: 5000, commandTimeout: 5000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  client.on('error', () => {}); // The awaited connect/call reports the error to the caller.
  try { await client.connect(); return await action(client); }
  finally { client.disconnect(); }
}
async function testRedis(settings, secret) { return withRedis(settings, secret, client => client.ping()); }
async function executeRedis(settings, secret, input = {}) {
  if (input.redisMutation !== undefined) {
    if (input.redisBrowse !== undefined || input.command !== undefined) throw invalid('Redis 修改请求不能混合浏览或命令');
    const params = validateRedisMutation(input.redisMutation, input.readOnly !== false);
    return withRedis(settings, secret, async client => { await input.authorizeRedisMutation?.(); return mutateRedis(client, params, input.authorizeRedisMutation); });
  }
  if (input.redisBrowse !== undefined) {
    validateRedisBrowse(input.redisBrowse);
    return withRedis(settings, secret, client => browseRedis(client, input.redisBrowse));
  }
  const { command, args, destructive } = validateRedisCommand(input.command, input.readOnly !== false);
  if (destructive && input.confirmDestructive !== true) throw invalid('请确认 Redis 删除或过期时间修改操作');
  if (command === 'GETRANGE' && (args.length !== 3 || !/^\d+$/.test(args[1]) || !/^\d+$/.test(args[2]) || Number(args[2]) < Number(args[1]) || Number(args[2]) - Number(args[1]) > 65535)) throw invalid('GETRANGE 每次最多读取 64 KiB，请填写非负范围');
  if (command === 'MGET' && (!args.length || args.length > 10)) throw invalid('MGET 每次最多读取 10 个键');
  if (command === 'SCAN') {
    if (!/^\d+$/.test(args[0] || '') || args.length > 5 || args.slice(1).some((arg, index) => index % 2 === 0 && !['MATCH', 'COUNT'].includes(arg.toUpperCase())) || args.length % 2 !== 1) throw invalid('SCAN 格式：SCAN cursor [MATCH pattern] [COUNT count]');
    let count = -1; const flags = new Set();
    for (let i = 1; i < args.length; i += 2) {
      const flag = args[i].toUpperCase();
      if (flags.has(flag)) throw invalid('SCAN 参数不能重复');
      flags.add(flag); if (flag === 'COUNT') count = i;
    }
    if (count >= 0 && (!/^\d+$/.test(args[count + 1]) || Number(args[count + 1]) < 1 || Number(args[count + 1]) > 100)) throw invalid('SCAN COUNT 范围为 1–100');
    if (count < 0) args.push('COUNT', '100');
  }
  return withRedis(settings, secret, async client => {
    if (WRITE.has(command)) await input.authorizeRedisMutation?.();
    const boundedGet = async key => {
      const totalBytes = await client.strlen(key);
      const exists = totalBytes || await client.exists(key);
      if (!exists) return null;
      const value = await client.getrange(key, 0, 65535);
      return { value, totalBytes, truncated: totalBytes > 65536 };
    };
    let result;
    if (command === 'GET') { if (args.length !== 1) throw invalid('GET 需要一个键名'); result = await boundedGet(args[0]); }
    else if (command === 'MGET') result = await Promise.all(args.map(boundedGet));
    else if (command === 'HGET') {
      if (args.length !== 2) throw invalid('HGET 需要键名和字段名');
      const totalBytes = await client.hstrlen(...args);
      result = totalBytes > 65536 ? { totalBytes, truncated: true, message: '哈希字段超过 64 KiB，未下载值' } : await client.hget(...args);
    } else result = await client.call(command, ...args);
    if (Buffer.byteLength(JSON.stringify(result)) > 256000) return { truncated: true, message: '结果超过 256 KB，请缩小读取范围' };
    return result;
  });
}
module.exports = { testRedis, executeRedis, validateRedisCommand };
