const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const output = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../web/src/lib/breakpoint-migration.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const exported = {}; new Function('exports', output)(exported);
const { migrateBreakpoints: move, BreakpointEditHistory, BreakpointDiskCheckpoints } = exported;
const edit = (start, column, end, endColumn, text) => ({ range: { startLineNumber: start, startColumn: column, endLineNumber: end, endColumn }, text });
test('insertions move original code, retaining conditional, hit-count and log metadata', () => {
  const point = { line: 4, condition: 'i==2', hitCondition: '3', logMessage: 'i={i}' };
  assert.deepEqual(move([2, point], [edit(4, 1, 4, 1, '// header\r\n\r\n')]), [2, { ...point, line: 6 }]);
  assert.deepEqual(point, { line: 4, condition: 'i==2', hitCondition: '3', logMessage: 'i={i}' });
  assert.deepEqual(move([4, 6], [edit(4, 3, 4, 3, '\n')]), [4, 7]);
});
test('deleting entire lines removes their points, moves following lines and keeps endpoint', () => {
  assert.deepEqual(move([2, 3, 4, 7], [edit(2, 1, 4, 1, '')]), [2, 5]);
  assert.deepEqual(move([2, 3, 4], [edit(2, 5, 4, 1, '')]), [2]);
});
test('replacement text retains start anchor; same-line edits do not move points', () => {
  assert.deepEqual(move([2, 3, 6], [edit(2, 1, 4, 1, 'replacement\n')]), [2, 5]);
  assert.deepEqual(move([2, 4], [edit(2, 1, 2, 10, 'other')]), [2, 4]);
});
test('multi-cursor changes use original coordinates regardless of input order', () => {
  const edits = [edit(2, 1, 2, 1, '\n'), edit(6, 1, 6, 1, '\n\n')];
  assert.deepEqual(move([2, 4, 6, 8], edits), [3, 5, 9, 11]);
  assert.deepEqual(move([2, 4, 6, 8], edits.reverse()), [3, 5, 9, 11]);
});
test('undo insertion restores lines and merging lines deduplicates deterministically', () => {
  const moved = move([4, 8], [edit(1, 1, 1, 1, '// new\n')]);
  assert.deepEqual(move(moved, [edit(1, 1, 2, 1, '')]), [4, 8]);
  assert.deepEqual(move([2, { line: 3, condition: 'true' }], [edit(2, 5, 3, 1, '')]), [{ line: 2, condition: 'true' }]);
});
test('undo and redo restore deleted advanced breakpoints without requiring remaining points', () => {
  const history = new BreakpointEditHistory();
  const original = [{ line: 4, condition: 'i==2', hitCondition: '3', logMessage: 'i={i}' }];
  assert.deepEqual(history.apply('A.java', 1, 2, original, [edit(4, 1, 5, 1, '')], false), []);
  const restored = history.apply('A.java', 2, 1, [], [edit(4, 1, 4, 1, 'code\n')], true);
  assert.deepEqual(restored, original);
  assert.deepEqual(history.apply('A.java', 1, 2, restored, [edit(4, 1, 5, 1, '')], true), []);
  assert.deepEqual(history.apply('B.java', 2, 1, [], [], true), []);
});
test('history invalidation prevents manual changes or reused models resurrecting stale points', () => {
  const history = new BreakpointEditHistory();
  history.apply('A.java', 1, 2, [4], [edit(1, 1, 1, 1, '\n')], false);
  history.clear('A.java');
  assert.deepEqual(history.apply('A.java', 2, 1, [], [edit(1, 1, 2, 1, '')], true), []);
});
test('history is bounded across files and does not retain mutable objects', () => {
  const history = new BreakpointEditHistory();
  const point = { line: 4, condition: 'true' };
  history.apply('A.java', 1, 2, [point], [], false); point.condition = 'changed';
  assert.equal(history.apply('A.java', 2, 1, [], [], true)[0].condition, 'true');
  for (let index = 0; index < 300; index++) history.apply(`F${index}.java`, 1, 2, Array.from({ length: 100 }, (_, line) => line + 1), [], false);
  assert.ok(history.snapshots.size <= 256); assert.ok(history.size <= 20000);
});
test('discarding a draft restores disk-aligned advanced points, not migrated editor lines', () => {
  const disk = new BreakpointDiskCheckpoints();
  const point = { line: 4, logMessage: 'x={x}', condition: 'true', hitCondition: '3' };
  disk.reset({ 'A.java': [point], 'B.java': [9] });
  point.line = 100;
  const current = { 'A.java': [{ ...point, line: 6 }], 'B.java': [10], 'New.java': [2] };
  assert.deepEqual(disk.discard('A.java', current), { ...current, 'A.java': [{ ...point, line: 4 }] });
  assert.deepEqual(disk.discard('New.java', current), { 'A.java': current['A.java'], 'B.java': [10] });
});
test('successful partial saves advance only their captured checkpoints despite later edits', () => {
  const disk = new BreakpointDiskCheckpoints(); disk.reset({ 'A.java': [4], 'B.java': [9] });
  const point = { line: 5, logMessage: 'saved' };
  const completeA = disk.capture('A.java', [point]);
  disk.capture('B.java', [10]); // failed/cancelled save: do not commit
  point.line = 7; point.logMessage = 'later edit'; completeA();
  assert.deepEqual(disk.discard('A.java', { 'A.java': [8], 'B.java': [10] }), { 'A.java': [{ line: 5, logMessage: 'saved' }], 'B.java': [10] });
  assert.deepEqual(disk.discard('B.java', { 'A.java': [8], 'B.java': [10] }), { 'A.java': [8], 'B.java': [9] });
  disk.reset({}); assert.deepEqual(disk.discard('A.java', { 'A.java': [4] }), {});
});
