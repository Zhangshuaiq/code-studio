const { decodeKey } = require('@codegen/code-intelligence/redis-browser.cjs');
const { createHash } = require('node:crypto');
const invalid = message => Object.assign(new Error(message), { code: 'LOCAL_CONNECTOR_INVALID' });
// Delete the precise index without a sentinel: duplicate/binary values remain
// distinct. Shift the shorter side, bounded to avoid a long Redis script.
const DELETE_LIST_INDEX = `
local n=redis.call('LLEN',KEYS[1]); local i=tonumber(ARGV[1])
if i<0 or i>=n then return redis.error_reply('List index changed') end
if math.min(i,n-i-1)>1000 then return redis.error_reply('List deletion shift exceeds limit') end
local pop=i<n-i-1 and 'LPOP' or 'RPOP'
if not redis.acl_check_cmd('LINDEX',KEYS[1],0) or not redis.acl_check_cmd('LSET',KEYS[1],0,'') or not redis.acl_check_cmd(pop,KEYS[1]) then return redis.error_reply('NOPERM list deletion requires LINDEX, LSET and pop permission') end
local moved={}; local bytes=0
if i<n-i-1 then
  for j=i,1,-1 do
    local v=redis.call('LINDEX',KEYS[1],j-1); bytes=bytes+#v
    if #v>16384 or bytes>1048576 then return redis.error_reply('List deletion values exceed resource limit') end
    moved[#moved+1]=v
  end
  for k,v in ipairs(moved) do redis.call('LSET',KEYS[1],i-k+1,v) end
  redis.call('LPOP',KEYS[1])
else
  for j=i,n-2 do
    local v=redis.call('LINDEX',KEYS[1],j+1); bytes=bytes+#v
    if #v>16384 or bytes>1048576 then return redis.error_reply('List deletion values exceed resource limit') end
    moved[#moved+1]=v
  end
  for k,v in ipairs(moved) do redis.call('LSET',KEYS[1],i+k-1,v) end
  redis.call('RPOP',KEYS[1])
end
return 1`;
function validateRedisMutation(input, readOnly) {
  if (readOnly) throw invalid('当前工作区仅允许 Redis 只读操作');
  if (!input || !['delete', 'expire', 'persist', 'create', 'edit', 'hash-create', 'hash-edit', 'hash-delete', 'set-create', 'set-delete', 'zset-create', 'zset-edit', 'zset-delete', 'list-push', 'list-edit', 'list-delete'].includes(input.action)) throw invalid('Redis 修改操作无效');
  if (input.confirm !== true) throw invalid('请确认 Redis 修改操作');
  const key = decodeKey(input);
  if (input.action === 'expire' && (!Number.isSafeInteger(input.seconds) || input.seconds < 1 || input.seconds > 2147483647)) throw invalid('TTL 秒数必须为 1–2147483647 的整数');
  if (input.expectedType !== undefined && !['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(input.expectedType)) throw invalid('Redis 键类型引用无效');
  let value;
  let field;
  let member;
  if (/^(?:set|zset)-/.test(input.action)) member = decodeKey({ key: input.member, keyEncoding: input.memberEncoding });
  const validScore = score => typeof score === 'string' && score.length <= 64 && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(score) && Number.isFinite(Number(score));
  if (['zset-create', 'zset-edit'].includes(input.action) && !validScore(input.score)) throw invalid('分数必须为有限数字');
  if (['zset-edit', 'zset-delete'].includes(input.action) && !validScore(input.expectedScore)) throw invalid('缺少原始分数，请刷新后重试');
  if (input.action.startsWith('hash-')) field = decodeKey({ key: input.field, keyEncoding: input.fieldEncoding });
  if (input.action.startsWith('list-')) {
    if (!Number.isSafeInteger(input.expectedLength) || input.expectedLength < 1 || input.expectedLength > 4294967295) throw invalid('列表长度引用无效，请刷新');
    if (input.action === 'list-push' && !['left', 'right'].includes(input.side)) throw invalid('请选择从头部或尾部新增');
    if (input.action !== 'list-push' && (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= input.expectedLength)) throw invalid('列表索引无效');
  }
  if (['edit', 'hash-edit', 'hash-delete', 'list-edit', 'list-delete'].includes(input.action) && (typeof input.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedVersion))) throw invalid('缺少完整值版本，请重新读取后编辑');
  if (['create', 'edit', 'hash-create', 'hash-edit', 'list-push', 'list-edit'].includes(input.action)) {
    if (typeof input.value !== 'string' || input.value.length > 25000 || !['utf8', 'base64', undefined].includes(input.valueEncoding)) throw invalid('Redis 值无效');
    if (input.valueEncoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.value)) throw invalid('Redis 值的 Base64 编码无效');
    value = Buffer.from(input.value, input.valueEncoding === 'base64' ? 'base64' : 'utf8');
    if (value.length > 16384) throw invalid('可视化写入每次最多 16 KiB');
    if (input.action === 'edit' && (typeof input.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedVersion))) throw invalid('缺少完整值版本，请重新读取后编辑');
  }
  return { action: input.action, key, seconds: input.seconds, expectedType: input.expectedType, value, field, expectedVersion: input.expectedVersion, member, score: input.score, expectedScore: input.expectedScore, index: input.index, expectedLength: input.expectedLength, side: input.side };
}
async function mutateRedis(client, params, authorize) {
  if (params.action.startsWith('list-')) {
    await client.watch(params.key);
    try {
      if (await client.type(params.key) !== 'list' || await client.llen(params.key) !== params.expectedLength) throw invalid('列表类型或长度已改变，请刷新');
      if (params.action !== 'list-push') {
        const current = await client.callBuffer('EVAL_RO', "local v=redis.call('LINDEX',KEYS[1],ARGV[1]); if not v or #v>16384 then return false end; return v", 1, params.key, params.index);
        if (current == null || createHash('sha256').update(current).digest('hex') !== params.expectedVersion) throw invalid('列表位置的值已改变或过大，请刷新');
      }
      if (params.action === 'list-delete' && Math.min(params.index, params.expectedLength - params.index - 1) > 1000) throw invalid('该位置删除需要移动超过 1000 项，暂不支持可视化删除');
      await authorize?.();
      const transaction = client.multi();
      if (params.action === 'list-push') { if (params.side === 'left') transaction.lpush(params.key, params.value); else transaction.rpush(params.key, params.value); }
      else if (params.action === 'list-edit') transaction.lset(params.key, params.index, params.value);
      else transaction.eval(DELETE_LIST_INDEX, 1, params.key, params.index);
      const result = await transaction.exec();
      if (!result) throw invalid('列表已并发修改，未覆盖，请刷新');
      if (result[0][0]) throw result[0][0];
      return { changed: true, action: params.action };
    } finally { await client.unwatch().catch(() => {}); }
  }
  if (/^(?:set|zset)-/.test(params.action)) {
    const kind = params.action.startsWith('zset-') ? 'zset' : 'set';
    await client.watch(params.key);
    try {
      if (await client.type(params.key) !== kind) throw invalid('集合键已改变或不存在，请刷新');
      const current = kind === 'set' ? await client.sismember(params.key, params.member) : await client.zscore(params.key, params.member);
      const present = kind === 'set' ? current === 1 : current !== null;
      if (params.action.endsWith('create') && present) throw invalid('成员已存在，未覆盖现有成员');
      if (!params.action.endsWith('create') && !present) throw invalid('成员已删除，请刷新');
      if (kind === 'zset' && !params.action.endsWith('create') && current !== params.expectedScore) throw invalid('成员分数已改变，未覆盖，请刷新');
      await authorize?.();
      const transaction = client.multi();
      if (kind === 'set') { if (params.action === 'set-create') transaction.sadd(params.key, params.member); else transaction.srem(params.key, params.member); }
      else if (params.action === 'zset-delete') transaction.zrem(params.key, params.member);
      else transaction.zadd(params.key, params.score, params.member);
      const result = await transaction.exec();
      if (!result) throw invalid('集合已并发修改，未覆盖，请刷新');
      if (result[0][0]) throw result[0][0];
      return { changed: true, action: params.action };
    } finally { await client.unwatch().catch(() => {}); }
  }
  if (params.action.startsWith('hash-')) {
    await client.watch(params.key);
    try {
      if (await client.type(params.key) !== 'hash') throw invalid('哈希键已改变或不存在，请刷新');
      const present = await client.hexists(params.key, params.field);
      if (params.action === 'hash-create' && present) throw invalid('字段已存在，未覆盖现有值');
      if (params.action !== 'hash-create') {
        if (!present) throw invalid('字段已删除，请刷新');
        const script = "local n=redis.call('HSTRLEN',KEYS[1],ARGV[1]); if n>16384 then return {n,false} end; return {n,redis.call('HGET',KEYS[1],ARGV[1])}";
        const [, current] = await client.callBuffer('EVAL_RO', script, 1, params.key, params.field);
        if (current == null || createHash('sha256').update(current).digest('hex') !== params.expectedVersion) throw invalid('字段已改变或过大，未覆盖，请刷新');
      }
      await authorize?.();
      const transaction = client.multi();
      if (params.action === 'hash-delete') transaction.hdel(params.key, params.field); else transaction.hset(params.key, params.field, params.value);
      const result = await transaction.exec();
      if (!result) throw invalid('哈希已并发修改，未覆盖，请刷新');
      if (result[0][0]) throw result[0][0];
      return { changed: true, action: params.action };
    } finally { await client.unwatch().catch(() => {}); }
  }
  if (params.action === 'create') {
    await authorize?.();
    const result = await client.set(params.key, params.value, 'NX');
    if (result !== 'OK') throw invalid('键已存在，未覆盖现有值');
    return { changed: true, action: 'create' };
  }
  if (params.action === 'edit') {
    await client.watch(params.key);
    try {
      if (await client.type(params.key) !== 'string' || await client.strlen(params.key) > 16384) throw invalid('键类型或大小已变化，请重新读取');
      const current = await client.getrangeBuffer(params.key, 0, 16383);
      if (createHash('sha256').update(current).digest('hex') !== params.expectedVersion) throw invalid('值已被修改，请重新读取后编辑');
      await authorize?.();
      const result = await client.multi().set(params.key, params.value, 'KEEPTTL').exec();
      if (!result) throw invalid('值或 TTL 已发生变化，未覆盖，请重新读取');
      if (result[0][0]) throw result[0][0];
      return { changed: true, action: 'edit' };
    } finally { await client.unwatch().catch(() => {}); }
  }
  const type = await client.type(params.key);
  if (type === 'none') throw invalid('键已过期或删除，请刷新列表');
  if (params.expectedType && params.expectedType !== type) throw invalid('键类型已发生变化，请刷新后重试');
  await authorize?.();
  const result = params.action === 'delete' ? await client.unlink(params.key) : params.action === 'expire' ? await client.expire(params.key, params.seconds) : await client.persist(params.key);
  return { changed: result === 1, action: params.action };
}
module.exports = { validateRedisMutation, mutateRedis };
