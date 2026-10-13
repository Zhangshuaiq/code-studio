const test = require('node:test'); const assert = require('node:assert/strict'); const Module = require('node:module'); const path = require('node:path'); const fs = require('node:fs'); const ts = require('typescript');
const file = path.resolve(__dirname, '../../web/src/lib/redis-command.ts'); const mod = new Module(file, module); mod.filename = file;
mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, file);
const { parseRedisCommand, isDestructiveRedisCommand } = mod.exports;
test('shared Redis parser preserves spaces, empty values, escaped quotes and unicode without eval', () => {
  assert.deepEqual(parseRedisCommand('set "my key" "value with spaces"'), ['SET', 'my key', 'value with spaces']);
  assert.deepEqual(parseRedisCommand('SET key ""'), ['SET', 'key', '']);
  assert.deepEqual(parseRedisCommand("SET key '你好'"), ['SET', 'key', '你好']);
  assert.deepEqual(parseRedisCommand('SET key "a\\"b"'), ['SET', 'key', 'a"b']);
  for (const value of ['SET key "bad', 'GET key\\', 'GET key\nDEL key']) assert.throws(() => parseRedisCommand(value));
  assert.equal(isDestructiveRedisCommand('del'), true); assert.equal(isDestructiveRedisCommand('GET'), false);
});
