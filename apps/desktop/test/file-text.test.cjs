const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { encodeText, decodeText, textEncoding } = require('@codegen/code-intelligence/file-text.cjs');
const { describeFile } = require('@codegen/code-intelligence/file-preview.cjs');
const { createLocalApi } = require('../src/local-api.cjs');
test('BOM-aware text codecs round-trip UTF-8/UTF-16 including Chinese, emoji and CRLF without replacing characters', () => {
  const content = '# 文档 😀\r\nSELECT 你好;\r\n';
  for (const format of [{ encoding: 'utf-8', bom: false }, { encoding: 'utf-8', bom: true }, { encoding: 'utf-16le', bom: true }, { encoding: 'utf-16be', bom: true }]) {
    const bytes = encodeText(content, format); assert.deepEqual(decodeText(bytes), { content, ...format }); assert.deepEqual(encodeText(decodeText(bytes).content, textEncoding(bytes)), bytes);
    const empty = encodeText('', format); assert.deepEqual(decodeText(empty), { content: '', ...format });
  }
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xff, 0xfe, 0]), Buffer.from([0xff, 0xfe, 0, 0xd8]), Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from([0, 0, 0xfe, 0xff]), Buffer.from([0])]) assert.throws(() => decodeText(bytes), { code: 'FILE_TEXT_ENCODING_INVALID' });
  for (const content of ['\0', '\ud800', '\udc00']) assert.throws(() => encodeText(content));
});
test('bounded sampling accepts partial code points but full decoding rejects truncation', () => {
  const bytes = encodeText('你好😀', { encoding: 'utf-16le', bom: true });
  assert.equal(decodeText(bytes.subarray(0, 7), true).content, '你好'); assert.throws(() => decodeText(bytes.subarray(0, 7)));
});
test('desktop reads and atomically saves native encoding, detects byte-only conflicts and never auto-converts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-encoding-api-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = await createLocalApi({ token: 'test-token' }); t.after(() => api.close()); const project = api.registerWorkspace(root);
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }; const base = `${api.origin}/api/local/projects/${project.id}/content`;
  for (const [name, format] of [['bom.md', { encoding: 'utf-8', bom: true }], ['little.sql', { encoding: 'utf-16le', bom: true }], ['big.xml', { encoding: 'utf-16be', bom: true }]]) {
    const file = path.join(root, name); fs.writeFileSync(file, encodeText('原文 😀\r\n', format)); assert.equal(describeFile(file).kind, 'text');
    const before = await (await fetch(`${base}?path=${name}`, { headers })).json(); assert.equal(before.content, '原文 😀\r\n'); assert.equal(before.encoding, format.encoding);
    const response = await fetch(base, { method: 'PUT', headers, body: JSON.stringify({ path: name, expectedVersion: before.version, content: '修改 😀\r\n' }) }); assert.equal(response.status, 200);
    const after = await (await fetch(`${base}?path=${name}`, { headers })).json(); assert.equal(after.content, '修改 😀\r\n'); assert.equal(after.encoding, format.encoding); assert.equal(after.version, (await response.json()).version);
    assert.deepEqual(fs.readFileSync(file), encodeText('修改 😀\r\n', format));
    fs.writeFileSync(file, encodeText('修改 😀\r\n')); // identical Unicode, different raw bytes
    assert.equal((await fetch(base, { method: 'PUT', headers, body: JSON.stringify({ path: name, expectedVersion: after.version, content: 'do not write' }) })).status, 409);
  }
});
