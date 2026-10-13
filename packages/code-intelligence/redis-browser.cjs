const { bytes, displayBuffer } = require('./redis-buffer.cjs');
const { createHash } = require('node:crypto');
const { collectionPage } = require('./redis-collection.cjs');
function invalid(message) { return Object.assign(new Error(message), { code: 'LOCAL_CONNECTOR_INVALID' }); }
function decodeKey(input) {
  if (typeof input.key !== 'string' || input.key.length > 12000 || !['utf8', 'base64', undefined].includes(input.keyEncoding)) throw invalid('Redis 键引用无效');
  if (input.keyEncoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.key)) throw invalid('Redis 键编码无效');
  const key = Buffer.from(input.key, input.keyEncoding === 'base64' ? 'base64' : 'utf8');
  if (key.length > 8192) throw invalid('Redis 键名超过 8 KiB，无法预览');
  return key;
}
function validateRedisBrowse(input) {
  if (!input || !['scan', 'inspect', 'value'].includes(input.action)) throw invalid('Redis 浏览操作无效');
  if (input.action === 'scan') {
    const cursor = input.cursor === undefined ? '0' : input.cursor;
    const match = input.match === undefined ? '*' : input.match;
    const count = input.count === undefined ? 50 : input.count;
    if (typeof cursor !== 'string' || !/^\d{1,20}$/.test(cursor) || typeof match !== 'string' || Buffer.byteLength(match) > 1000 || !Number.isInteger(count) || count < 1 || count > 100) throw invalid('Redis 扫描参数无效');
    return { action: 'scan', cursor, match, count };
  }
  const key = decodeKey(input);
  const offset = input.offset === undefined ? 0 : input.offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 512 * 1024 * 1024) throw invalid('Redis 字节偏移无效');
  const cursor = input.cursor === undefined ? '0' : input.cursor;
  const count = input.count === undefined ? 25 : input.count;
  const scanOffset = input.scanOffset === undefined ? 0 : input.scanOffset;
  if (typeof cursor !== 'string' || !/^\d{1,20}$/.test(cursor) || !Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(scanOffset) || scanOffset < 0 || scanOffset > 1000000) throw invalid('Redis 集合分页参数无效');
  return { action: input.action, key, offset, cursor, count, scanOffset };
}
async function browseRedis(client, input) {
  const params = validateRedisBrowse(input);
  if (params.action === 'scan') {
    const [cursor, raw] = await client.scanBuffer(params.cursor, 'MATCH', params.match, 'COUNT', params.count);
    const items = []; let budget = 0; let omitted = 0;
    for (const value of raw) {
      const row = displayBuffer(value); const item = { key: row.value, keyEncoding: row.encoding, bytes: row.bytes }; const cost = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (row.bytes > 8192 || budget + cost > 128000 || items.length >= 500) { omitted++; continue; }
      budget += cost; items.push(item);
    }
    return { cursor: bytes(cursor).toString('ascii'), items, omitted, partial: omitted > 0, complete: bytes(cursor).toString('ascii') === '0' && omitted === 0 };
  }
  const type = await client.type(params.key); const ttlMs = await client.pttl(params.key);
  if (type === 'none' || ttlMs === -2) return { type: 'none', ttlMs: -2, exists: false };
  const sizeCommand = { string: 'STRLEN', hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' }[type];
  const size = sizeCommand ? Number(await client.call(sizeCommand, params.key)) : null;
  if (params.action === 'inspect') return { type, ttlMs, exists: true, size, sizeUnit: type === 'string' ? 'bytes' : 'items' };
  if (['hash', 'list', 'set', 'zset'].includes(type)) return { type, ttlMs, exists: true, size, ...await collectionPage(client, params, type, size) };
  if (type !== 'string') return { type, ttlMs, exists: true, size, supported: false, message: '当前类型暂不支持值预览，可使用命令编辑器' };
  const buffer = await client.getrangeBuffer(params.key, params.offset, params.offset + 16383);
  const data = displayBuffer(buffer);
  return { type, ttlMs, exists: true, size, supported: true, ...data, ...(params.offset === 0 && size === buffer.length ? { version: createHash('sha256').update(buffer).digest('hex') } : {}), offset: params.offset, nextOffset: params.offset + buffer.length, hasMore: params.offset + buffer.length < size, truncated: params.offset > 0 || params.offset + buffer.length < size };
}
module.exports = { browseRedis, validateRedisBrowse, displayBuffer, decodeKey };
