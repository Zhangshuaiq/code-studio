const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { utf8ProcessEnvironment, pipeUtf8Output } = require('@codegen/code-intelligence/process-text.cjs');
test('GUI child processes receive UTF-8 locale, preserving existing UTF-8 locales and unrelated settings', () => {
  const original = { LC_ALL: 'C', LANG: 'C', KEEP: 'yes' };
  assert.deepEqual(utf8ProcessEnvironment(original, 'darwin'), { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8', KEEP: 'yes' });
  assert.equal(original.LANG, 'C');
  assert.equal(utf8ProcessEnvironment({ LC_CTYPE: 'UTF-8', LANG: 'C', LC_ALL: 'C' }, 'darwin').LC_ALL, 'en_US.UTF-8');
  assert.equal(utf8ProcessEnvironment({ LANG: 'zh_CN.UTF-8' }, 'darwin').LANG, 'zh_CN.UTF-8');
  assert.equal(utf8ProcessEnvironment({}, 'linux').LC_CTYPE, 'C.UTF-8');
  assert.deepEqual(utf8ProcessEnvironment(original, 'win32'), original);
});
test('stdout and stderr decode split Chinese UTF-8 independently without replacement characters', async () => {
  const out = new PassThrough(), err = new PassThrough(); let a = '', b = '';
  pipeUtf8Output(out, text => { a += text; }); pipeUtf8Output(err, text => { b += text; });
  const text = '找不到符号：方法 all()\n位置：变量 用户'; const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i++) { out.write(bytes.subarray(i, i + 1)); err.write(bytes.subarray(i, i + 1)); }
  const ended = Promise.all([new Promise(resolve => out.once('end', resolve)), new Promise(resolve => err.once('end', resolve))]);
  out.end(); err.end(); await ended;
  assert.equal(a, text); assert.equal(b, text); assert.ok(!a.includes('\ufffd'));
});
