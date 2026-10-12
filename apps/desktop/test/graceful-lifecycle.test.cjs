const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installGracefulQuit } = require('../src/graceful-lifecycle.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(close, options) {
  const app = new EventEmitter(); const events = []; let quits = 0;
  app.quit = () => { quits++; app.emit('before-quit', { preventDefault() { throw new Error('completed quit must not be prevented'); } }); };
  installGracefulQuit(app, close, { onEvent: event => events.push(event), ...options });
  return { request: () => { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); return prevented; }, events, quits: () => quits };
}
test('quit waits for cleanup, repeated requests share one cleanup and the final quit is not intercepted', async () => {
  let release; let calls = 0;
  const runtime = fixture(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  assert.equal(runtime.request(), true); await tick();
  assert.equal(runtime.quits(), 0); assert.equal(runtime.request(), true); assert.equal(calls, 1);
  release(); await tick(); assert.equal(runtime.quits(), 1);
  assert.ok(runtime.events.some(event => event.event === 'quit-ready'));
});
test('cancelled unsaved-file confirmation does not stop runtimes and allows retry', async () => {
  let allowed = false; let calls = 0;
  const runtime = fixture(async () => { calls++; }, { canQuit: async () => allowed });
  runtime.request(); await tick(); assert.equal(calls, 0); assert.equal(runtime.quits(), 0);
  allowed = true; runtime.request(); await tick(); assert.equal(calls, 1); assert.equal(runtime.quits(), 1);
});
test('a stuck shutdown has a bounded deadline and records the failure', async () => {
  const runtime = fixture(() => new Promise(() => {}), { timeoutMs: 10 });
  runtime.request(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(runtime.quits(), 1); assert.ok(runtime.events.some(event => event.event === 'quit-cleanup-error'));
});
