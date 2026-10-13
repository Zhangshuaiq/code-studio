const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const zlib = require('node:zlib');
const { readDownload, extract } = require('@codegen/code-intelligence/scripts/install-java-tools.cjs');
function response(body, encoding) { const stream = Readable.from([body]); stream.headers = encoding ? { 'content-encoding': encoding } : {}; return stream; }
test('Java tools decode HTTP gzip/deflate/br responses before ZIP extraction', async () => {
  const body = Buffer.from('PK\x03\x04 VSIX fixture bytes');
  for (const [encoding, data] of [[undefined, body], ['identity', body], ['gzip', zlib.gzipSync(body)], ['deflate', zlib.deflateSync(body)], ['br', zlib.brotliCompressSync(body)]]) assert.deepEqual(await readDownload(response(data, encoding)), body);
});
test('Java tools reject truncated compressed bodies, unknown encodings and expansion over budget', async () => {
  const gzip = zlib.gzipSync(Buffer.from('archive content'));
  await assert.rejects(readDownload(response(gzip.subarray(0, gzip.length - 5), 'gzip')));
  await assert.rejects(readDownload(response(Buffer.alloc(1), 'unknown')), /编码不支持/);
  await assert.rejects(readDownload(response(zlib.gzipSync(Buffer.alloc(1024)), 'gzip'), 16), /文件过大/);
  await assert.rejects(extract(Buffer.from('<html>error</html>'), 'plugin.jar'), /不是有效/);
  await assert.rejects(extract(Buffer.from('PK\x03\x04 truncated'), 'plugin.jar'));
});
