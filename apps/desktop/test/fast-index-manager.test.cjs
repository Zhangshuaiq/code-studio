const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FastIndexManager } = require('@codegen/code-intelligence/fast-index-manager.cjs');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-index-manager-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'A.java'), 'class PersistedService {}');
  const manager = new FastIndexManager({ directory: path.join(root, 'index'), ...options });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, manager, project: { id: 'owner/project/main', path: workspace } };
}
test('shared manager persists across eviction, isolates identities and rejects after close', async t => {
  const { manager, project, root } = fixture(t, { maxWorkers: 1 });
  assert.equal((await manager.refresh(project)).complete, true);
  assert.equal((await manager.search(project, 'Persisted')).items[0].name, 'PersistedService');
  const other = { ...project, id: 'other/project/main' };
  await manager.refresh(other);
  assert.equal(manager.entries.size, 1);
  assert.equal(fs.readdirSync(path.join(root, 'index')).filter(file => file.endsWith('.sqlite3')).length, 2);
  assert.equal((await manager.refresh(project)).parsedFiles, 0);
  await manager.close(); await manager.close();
  await assert.rejects(manager.search(project, 'Persisted'), { code: 'FAST_INDEX_CLOSED' });
});
test('active requests cannot be evicted; idle threads are reaped', async t => {
  const { manager, project } = fixture(t, { maxWorkers: 1, idleMs: 10 });
  const entry = await manager.acquire(project);
  await assert.rejects(manager.search({ ...project, id: 'other' }, 'Persisted'), { code: 'FAST_INDEX_BUSY' });
  assert.equal(manager.entries.size, 1);
  entry.leases--; entry.usedAt = Date.now() - 100;
  await manager.maintain(); assert.equal(manager.entries.size, 0);
});
test('explicit invalidation and periodic validation pick up edits without retaining source', async t => {
  const { manager, project, workspace } = fixture(t, { intervalMs: 20 });
  await manager.refresh(project);
  fs.writeFileSync(path.join(workspace, 'A.java'), 'class ChangedService {}');
  await manager.invalidate(project); await manager.refresh(project);
  assert.equal((await manager.search(project, 'Changed')).items.length, 1);
  fs.unlinkSync(path.join(workspace, 'A.java'));
  const entry = [...manager.entries.values()][0]; entry.refreshedAt = 0;
  await manager.maintain(); await entry.client.refresh();
  assert.equal((await manager.search(project, 'Changed')).items.length, 0);
});

test('save bursts coalesce into one scan and cached results remain explicitly unvalidated', async t => {
  const { manager, project, workspace } = fixture(t, { debounceMs: 100, maxDebounceMs: 300 });
  await manager.refresh(project);
  let scans = 0;
  const scan = manager.scan.bind(manager);
  manager.scan = (...args) => { scans++; return scan(...args); };
  fs.writeFileSync(path.join(workspace, 'A.java'), 'class BurstService {}');
  for (let i = 0; i < 10; i++) await manager.invalidate(project);
  assert.equal(scans, 0);
  const cached = await manager.search(project, 'Persisted');
  assert.equal(cached.index.complete, false);
  assert.equal(cached.index.state, 'needs-validation');
  assert.equal(cached.sourceTruncated, true);
  assert.equal((await manager.outline(project, 'A.java')).index.complete, false);
  const deadline = Date.now() + 5000;
  while (!(await manager.status(project)).complete && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await manager.status(project)).complete, true);
  assert.equal(scans, 1);
  assert.equal((await manager.search(project, 'Burst')).items[0].name, 'BurstService');
  assert.equal((await manager.search(project, 'Persisted')).items.length, 0);
});

test('root invalidation is scoped and an explicit refresh bypasses the pending timer', async t => {
  const { manager, project, workspace, root } = fixture(t, { maxWorkers: 3, debounceMs: 1000 });
  const branch = { ...project, id: 'owner/project/other-branch' };
  const elsewhere = path.join(root, 'elsewhere'); fs.mkdirSync(elsewhere);
  const other = { id: 'other-root', path: elsewhere };
  await manager.refresh(project); await manager.refresh(branch); await manager.refresh(other);
  await manager.invalidateRoot(workspace);
  assert.equal((await manager.status(project)).complete, false);
  assert.equal((await manager.status(branch)).complete, false);
  assert.equal((await manager.status(other)).complete, true);
  await manager.invalidate(project, true);
  const active = [...manager.entries.values()].find(entry => entry.root === fs.realpathSync(workspace) && entry.invalidationTimer === null);
  assert.ok(active, 'manual refresh must cancel the debounce timer immediately');
  if (active.client.refreshPromise) await active.client.refreshPromise;
  assert.equal((await manager.status(project)).complete, true);
  const entry = [...manager.entries.values()].find(entry => entry.root === fs.realpathSync(workspace) && !entry.dirty);
  assert.equal(entry.invalidationTimer, null);
  const entries = [...manager.entries.values()];
  await manager.close();
  for (const entry of entries) assert.equal(entry.invalidationTimer, null);
});

test('an older scan completion cannot clear a newer invalidation', async t => {
  const { manager, project } = fixture(t, { debounceMs: 1000 });
  await manager.refresh(project);
  const entry = [...manager.entries.values()][0];
  const refresh = entry.client.refresh.bind(entry.client);
  let finish;
  entry.client.refresh = () => new Promise(resolve => { finish = resolve; });
  const older = manager.scan(entry, true);
  await manager.invalidate(project);
  finish({ complete: true }); await older;
  assert.equal((await manager.status(project)).complete, false);
  entry.client.refresh = refresh;
  await manager.refresh(project);
  assert.equal((await manager.status(project)).complete, true);
});

test('continued events cannot postpone a scan indefinitely and close cancels pending scans', async t => {
  const { manager, project } = fixture(t, { debounceMs: 100, maxDebounceMs: 150 });
  await manager.refresh(project);
  let scans = 0;
  const scan = manager.scan.bind(manager);
  manager.scan = (...args) => { scans++; return scan(...args); };
  for (let i = 0; i < 8 && !scans; i++) { await manager.invalidate(project); await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.ok(scans >= 1, 'continuous changes must flush within the maximum debounce window');
  await manager.invalidate(project);
  await manager.close();
  const finalScans = scans;
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(scans, finalScans);
  assert.throws(() => new FastIndexManager({ directory: os.tmpdir(), debounceMs: 200, maxDebounceMs: 100 }), /debounce/);
});
