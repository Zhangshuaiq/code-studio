const { displayBuffer: display } = require('./redis-buffer.cjs');
const { createHash } = require('node:crypto');
// Only immutable, application-owned read scripts are accepted. Never execute a
// supplied script or retry EVAL_RO with EVAL after an ACL/version failure.
const PAGE_SCRIPT = `
local kind = ARGV[1]
local cursor = ARGV[2]
local skip = tonumber(ARGV[3])
local count = tonumber(ARGV[4])
local offset = tonumber(ARGV[5])
local rows = {}
local function name(v)
  return {#v, string.sub(v,1,1024), #v <= 1024 and v or false}
end
if kind == 'hash' then
  local page = redis.call('HSCAN',KEYS[1],cursor,'COUNT',count,'NOVALUES')
  for i=skip+1,math.min(skip+count,#page[2]) do
    local field = page[2][i]
    local n = redis.call('HSTRLEN',KEYS[1],field)
    local v = n <= 1024 and redis.call('HGET',KEYS[1],field) or false
    rows[#rows+1] = {name(field),n,v}
  end
  return {page[1],#page[2],rows}
elseif kind == 'set' then
  local page = redis.call('SSCAN',KEYS[1],cursor,'COUNT',count)
  for i=skip+1,math.min(skip+count,#page[2]) do rows[#rows+1] = {name(page[2][i])} end
  return {page[1],#page[2],rows}
elseif kind == 'list' then
  for i=offset,offset+count-1 do
    local v = redis.call('LINDEX',KEYS[1],i)
    if not v then break end
    rows[#rows+1] = {i,#v,string.sub(v,1,1024)}
  end
  return {'0',#rows,rows}
elseif kind == 'zset' then
  local page = redis.call('ZRANGE',KEYS[1],offset,offset+count-1,'WITHSCORES')
  for i=1,#page,2 do rows[#rows+1] = {name(page[i]),page[i+1]} end
  return {'0',#rows,rows}
end
return redis.error_reply('Unsupported collection type')
`;
async function collectionPage(client, params, type, size) {
  const count = Math.min(params.count, 25);
  let response;
  try { response = await client.callBuffer('EVAL_RO', PAGE_SCRIPT, 1, params.key, type, params.cursor, params.scanOffset, count, params.offset); }
  catch (error) {
    if (/NOPERM|unknown command|syntax error/i.test(error.message || '')) return { supported: false, message: type === 'hash' ? '哈希分页需要 Redis 7.4+ 的 HSCAN NOVALUES 和只读脚本权限' : '集合分页需要 Redis 7+ 和 EVAL_RO 只读脚本权限' };
    throw error;
  }
  const [nextCursor, batchSize, raw] = response;
  const named = tuple => ({ name: display(tuple[1]), nameBytes: Number(tuple[0]), reference: tuple[2] == null ? null : display(tuple[2]), nameTruncated: Number(tuple[0]) > 1024 });
  const items = raw.map(row => {
    if (type === 'hash') return { ...named(row[0]), valueBytes: Number(row[1]), value: row[2] == null ? null : display(row[2]), ...(row[2] == null ? {} : { version: createHash('sha256').update(row[2]).digest('hex') }), truncated: row[2] == null };
    if (type === 'set' || type === 'zset') return { ...named(row[0]), ...(type === 'zset' ? { score: row[1].toString() } : {}) };
    return { index: Number(row[0]), valueBytes: Number(row[1]), value: display(row[2]), ...(Number(row[1]) <= 1024 ? { version: createHash('sha256').update(row[2]).digest('hex') } : {}), truncated: Number(row[1]) > 1024 };
  });
  const scan = type === 'hash' || type === 'set';
  const remainingBatch = scan && params.scanOffset + count < Number(batchSize);
  const cursor = remainingBatch ? params.cursor : nextCursor.toString();
  const nextOffset = params.offset + items.length;
  return { supported: true, pageKind: 'collection', items, offset: params.offset, nextOffset, cursor, pageCursor: params.cursor, scanOffset: params.scanOffset, nextScanOffset: remainingBatch ? params.scanOffset + count : 0, hasMore: scan ? remainingBatch || cursor !== '0' : nextOffset < size, partial: items.some(item => item.truncated || item.nameTruncated), count };
}
module.exports = { collectionPage };
