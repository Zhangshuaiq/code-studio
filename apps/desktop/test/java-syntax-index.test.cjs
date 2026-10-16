const test = require('node:test');
const assert = require('node:assert/strict');
const { JavaSyntaxIndex } = require('@codegen/code-intelligence/java-syntax-index.cjs');
async function parser(t) { const value = await JavaSyntaxIndex.create(); t.after(() => value.close()); return value; }
test('native extraction matches legacy source order, scopes and incomplete syntax metadata', async t => {
  const value = await parser(t);
  const sources = [
    'class Outer { void run() { class Local { int field; void nested() {} } Runnable r = new Runnable() { public void run() {} }; } class Member {} }',
    'record Pair<T>(T left, T right) { public Pair {} } enum E { ONE { void run() {} }, TWO; int n; } @interface Mark { String value(); }',
    'class Broken { void bad(',
    'package 示例;\r\nclass 中文 { String 提示="😀"; void 方法() {} }',
  ];
  for (const source of sources) {
    const { visitedNodes: a, ...native } = value.parse(source, 'Scope.java');
    const { visitedNodes: b, ...legacy } = value.parse(source, 'Scope.java', { legacyTraversal: true });
    assert.deepEqual(native, legacy);
  }
});

test('Java syntax index covers declarations, overloads, records, imports and unresolved inheritance', async t => {
  const value = await parser(t);
  const result = value.parse(`package demo;
import java.util.List;
import static java.util.Collections.*;
@Deprecated public class Outer<T> extends Base<T> implements Runnable {
  private String first, second;
  public Outer() {}
  public void run() {}
  public T map(T input) { return input; }
  public T map(T input, int n) { return input; }
  interface Nested extends Runnable { void nested(); }
  record Pair<T>(T left, T right) { public Pair {} }
  enum State { READY, DONE }
  @interface Mark { String value(); }
}`, 'src/Outer.java');
  assert.equal(result.packageName, 'demo'); assert.equal(result.hasErrors, false); assert.equal(result.truncated, false);
  const kinds = name => result.symbols.filter(symbol => symbol.name === name).map(symbol => symbol.kind);
  assert.deepEqual(kinds('map'), ['method', 'method']);
  assert.deepEqual(kinds('Outer'), ['class', 'constructor']);
  assert.deepEqual(kinds('first'), ['field']); assert.deepEqual(kinds('second'), ['field']);
  assert.deepEqual(kinds('Pair'), ['record', 'constructor']); assert.deepEqual(kinds('left'), ['recordComponent']);
  assert.deepEqual(kinds('READY'), ['enumMember']); assert.deepEqual(kinds('Mark'), ['annotation']);
  assert.equal(result.symbols.find(symbol => symbol.name === 'nested').container, 'Outer.Nested');
  assert.equal(result.imports[1].static, true); assert.equal(result.imports[1].name, 'java.util.Collections.*');
  assert.equal(result.inheritance.some(item => item.clause === 'extends Base<T>'), true);
  assert.equal(result.inheritance.every(item => item.resolved === false), true); assert.equal(result.semantic, false);
});

test('Java name coordinates match UTF-16 editor coordinates with Chinese, emoji and CRLF', async t => {
  const value = await parser(t);
  const source = 'package 示例;\r\nclass 中文 { String 提示="😀"; void 方法() {} }\r\n';
  const result = value.parse(source, '中文.java');
  const symbol = result.symbols.find(item => item.name === '方法');
  assert.equal(symbol.line, 2);
  assert.equal(symbol.column, source.split('\r\n')[1].indexOf('方法') + 1);
  assert.equal(symbol.selectionRange.end.column - symbol.column, 2);
  assert.equal(result.packageName, '示例');
});

test('CR-only Java files use the same line positions as Monaco', async t => {
  const value = await parser(t);
  const result = value.parse('// 示例 😀\rclass Service {\r  void method() {}\r}', 'Service.java');
  assert.equal(result.symbols.find(symbol => symbol.name === 'Service').line, 2);
  assert.equal(result.symbols.find(symbol => symbol.name === 'Service').column, 7);
  assert.equal(result.symbols.find(symbol => symbol.name === 'method').line, 3);
});

test('Java incomplete syntax is explicitly marked, budgets are bounded and trees do not leak across files', async t => {
  const value = await parser(t);
  assert.equal(value.parse('class Incomplete { void method(', 'Incomplete.java').hasErrors, true);
  assert.equal(value.parse('class Small { int a; int b; }', 'Small.java', { maxNodes: 2 }).truncated, true);
  assert.equal(value.parse('class Small {}', 'Small.java').truncated, false);
  assert.throws(() => value.parse('class Large {}', 'Large.java', { maxBytes: 4 }), { code: 'FAST_INDEX_FILE_TOO_LARGE' });
  assert.throws(() => value.parse('', '../Outside.java'), /relative/);
  assert.throws(() => value.parse('', 'Invalid.java', { maxNodes: 0 }), /positive/);
  value.close(); value.close(); assert.throws(() => value.parse('', 'Closed.java'), /closed/);
});
