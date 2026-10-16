const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalLspManager } = require('@codegen/code-intelligence');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-restart-'));
  fs.writeFileSync(path.join(root, 'pom.xml'), '<project/>');
  fs.writeFileSync(path.join(root, 'Main.java'), 'class Main {}');
  const manager = new LocalLspManager();
  t.after(async () => { for (const [key, session] of manager.sessions) if (!session.diagnostics) manager.sessions.delete(key); manager.stoppingByKey.clear(); await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, project: { id: 'restart', path: root } };
}
test('same-project preparation waits for the previous shutdown and reuses one replacement', async t => {
  const { manager, project } = fixture(t);
  let finish;
  const stopping = new Promise(resolve => { finish = resolve; });
  manager.stoppingByKey.set('restart:java', stopping);
  let completed = false;
  const first = manager.prepareProject(project).then(result => { completed = true; return result; });
  const second = manager.prepareProject(project);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(completed, false);
  assert.equal(manager.sessions.size, 0, 'no new process may start before shutdown completes');
  manager.sessions.set('restart:java', { ready: Promise.resolve({ provider: 'java' }) });
  manager.stoppingByKey.delete('restart:java'); finish();
  assert.deepEqual((await first).providers, [{ provider: 'java', ready: true }]);
  assert.deepEqual(await second, await first);
});
test('global shutdown prevents a queued restart from launching after its wait', async t => {
  const { manager, project } = fixture(t);
  let finish;
  manager.stoppingByKey.set('restart:java', new Promise(resolve => { finish = resolve; }));
  const preparing = manager.prepareProject(project);
  manager.shuttingDown = true; finish();
  const result = await preparing;
  assert.equal(result.providers[0].ready, false);
  assert.equal(manager.sessions.size, 0);
});
test('unconfirmed process exit fails preparation without starting a competing process', async t => {
  const { manager, project } = fixture(t);
  manager.blockedRestarts.set('restart:java', {});
  const blocked = await manager.prepareProject(project);
  assert.equal(blocked.providers[0].ready, false);
  assert.match(blocked.providers[0].message, /尚未退出/);
  assert.equal(manager.sessions.size, 0);
  // A confirmed close removes the fence; preparation can reuse a valid replacement.
  manager.blockedRestarts.delete('restart:java');
  manager.sessions.set('restart:java', { ready: Promise.resolve({}) });
  assert.equal((await manager.prepareProject(project)).providers[0].ready, true);
});
test('real language session restart during shutdown waits for stopped before spawning', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-restart-real-'));
  fs.writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;');
  const project = { id: 'real-restart', path: root };
  const events = [];
  let restart, resolveRestart;
  const startedRestart = new Promise(resolve => { resolveRestart = resolve; });
  const manager = new LocalLspManager({ idleMs: 2000, onLifecycle: event => {
    events.push(event.event);
    if (event.event === 'shutdown-request' && !restart) {
      restart = manager.request(project, 'documentSymbols', { path: 'main.ts' });
      restart.catch(() => {}); resolveRestart();
    }
  } });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  await manager.request(project, 'documentSymbols', { path: 'main.ts' });
  await startedRestart;
  assert.ok((await restart).some(symbol => symbol.name === 'answer'));
  const stopped = events.indexOf('stopped');
  const secondSpawn = events.indexOf('spawn', events.indexOf('spawn') + 1);
  assert.ok(stopped >= 0 && secondSpawn > stopped, 'replacement process starts only after previous stop finishes');
  assert.equal(manager.stoppingByKey.size, 0);
});
