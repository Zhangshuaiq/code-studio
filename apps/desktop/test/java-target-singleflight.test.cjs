const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalJavaRuntime } = require('../src/local-java-runtime.cjs');
test('concurrent entry discovery shares work, but refresh and other projects do not share stale results', async () => {
  let calls = 0, finish;
  const runtime = new LocalJavaRuntime({ javaCommand: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const project = { id: 'one', path: __dirname };
  const first = runtime.targets(project), second = runtime.targets(project);
  await Promise.resolve(); assert.equal(calls, 1);
  finish([{ mainClass: 'demo.Main' }]);
  assert.deepEqual(await first, await second);
  const refresh = runtime.targets(project);
  await Promise.resolve(); assert.equal(calls, 2); finish([]); await refresh;
  const other = runtime.targets({ ...project, id: 'two' });
  await Promise.resolve(); assert.equal(calls, 3); finish([]); await other;
});
test('failed discovery is not retained and can be retried', async () => {
  let calls = 0;
  const runtime = new LocalJavaRuntime({ javaCommand: async () => { if (++calls === 1) throw new Error('busy'); return []; } });
  const project = { id: 'one', path: __dirname };
  await assert.rejects(runtime.targets(project), /busy/);
  assert.deepEqual(await runtime.targets(project), []); assert.equal(calls, 2);
});
