const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceIndex } = require('../src/workspace-index.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-index-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { root, cache: path.join(directory, 'cache'), project: { id: 'project', path: root } };
}

test('index persists across runtimes and serves the previous snapshot before background refresh', async (t) => {
  const { root, cache, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'Main.java'), 'class Main {}');
  const first = new WorkspaceIndex({ directory: cache });
  await first.get(project);
  await first.close();
  assert.ok((await fs.readdir(cache)).some((file) => file.endsWith('.json')));
  await fs.writeFile(path.join(root, 'New.java'), 'class New {}');
  const changes = [];
  const next = new WorkspaceIndex({ directory: cache, onChanges: async (_project, values) => changes.push(...values) });
  t.after(() => next.close());
  const cached = await next.get(project);
  assert.deepEqual(cached.items.map((item) => item.path), ['Main.java']);
  const fresh = await next.get(project, true);
  assert.ok(fresh.items.some((item) => item.path === 'New.java'));
  assert.ok(changes.some((item) => item.path === 'New.java' && item.type === 1));
});

test('periodic updates report changed/deleted files, ignore generated trees and never follow symlinks', async (t) => {
  const { root, cache, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'Main.java'), 'class Main {}');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'ignored');
  await fs.symlink(cache, path.join(root, 'outside'));
  const changes = [];
  const index = new WorkspaceIndex({ directory: cache, intervalMs: 25, onChanges: async (_project, values) => changes.push(...values) });
  t.after(() => index.close());
  const initial = await index.get(project);
  assert.deepEqual(initial.items.map((item) => item.path), ['Main.java']);
  await fs.writeFile(path.join(root, 'Main.java'), 'class Main { int changed; }');
  for (let attempt = 0; attempt < 100 && !changes.some((item) => item.type === 2); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(changes.some((item) => item.path === 'Main.java' && item.type === 2));
  await fs.unlink(path.join(root, 'Main.java'));
  await index.get(project, true);
  assert.ok(changes.some((item) => item.path === 'Main.java' && item.type === 3));
});

test('corrupt cache is rebuilt and projects remain isolated', async (t) => {
  const { root, cache, project } = await fixture(t);
  const first = new WorkspaceIndex({ directory: cache });
  await first.get(project); await first.close();
  const file = (await fs.readdir(cache)).find((file) => file.endsWith('.json'));
  await fs.writeFile(path.join(cache, file), '{broken');
  await fs.writeFile(path.join(root, 'Main.java'), 'class Main {}');
  const index = new WorkspaceIndex({ directory: cache });
  t.after(() => index.close());
  assert.equal((await index.get(project)).items[0].path, 'Main.java');
  const otherRoot = path.join(root, 'other'); await fs.mkdir(otherRoot);
  await fs.writeFile(path.join(otherRoot, 'Other.java'), 'class Other {}');
  const other = await index.get({ id: 'other', path: otherRoot });
  assert.deepEqual(other.items.map((item) => item.path), ['Other.java']);
});

for (const storage of ['file', 'sqlite']) test(`${storage} navigation results restore on demand, avoid starting a language server, and invalidate on changes`, async (t) => {
  const { root, cache, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'Source.ts'), 'export interface Greeting {}');
  await fs.writeFile(path.join(root, 'Implementation.ts'), 'export class GreetingImpl {}');
  const input = { path: 'Source.ts', line: 1, column: 18 };
  const result = [{ path: 'Implementation.ts', range: { start: { line: 0, character: 13 }, end: { line: 0, character: 25 } } }];
  const first = new WorkspaceIndex({ directory: cache, storage });
  await first.get(project); await first.setNavigation(project, 'implementation', input, result);
  await first.close();
  const next = new WorkspaceIndex({ directory: cache, storage });
  t.after(() => next.close());
  assert.deepEqual(await next.getNavigation(project, 'implementation', input), result);
  const { LocalLspManager } = require('../src/local-lsp-manager.cjs');
  const manager = new LocalLspManager({ navigationCache: next });
  t.after(() => manager.shutdown());
  assert.deepEqual(await manager.request(project, 'implementation', input), result);
  assert.equal(manager.sessions.size, 0, 'Warm cached navigation must not wait for LSP startup');
  assert.equal(await next.getNavigation(project, 'implementation', { ...input, content: 'unsaved interface Other {}' }), undefined);
  await next.get(project, true); // Settle the initial background validation.
  const revision = (await next.get(project)).revision;
  await fs.writeFile(path.join(root, 'Implementation.ts'), 'export class ChangedImplementation {}');
  await next.get(project, true);
  assert.equal(await next.getNavigation(project, 'implementation', input), undefined);
  assert.ok((await next.get(project)).revision > revision);
  assert.equal(next.pendingQueries(project)[0].operation, 'implementation');
  await next.setNavigation(project, 'implementation', input, result, revision);
  assert.equal(await next.getNavigation(project, 'implementation', input), undefined, 'Discard a result from an older project revision');
});

test('navigation memory is bounded by bytes and entry count, with least-recently-used eviction', async (t) => {
  const { root, cache, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'Main.java'), 'class Main {}');
  const index = new WorkspaceIndex({ directory: cache });
  t.after(() => index.close());
  await index.get(project);
  const state = [...index.states.values()][0];
  for (let number = 0; number < 250; number++) index.remember(state, String(number), { input: { path: 'Main.java' }, result: [{ path: 'Main.java', detail: 'x'.repeat(60_000) }] });
  assert.ok(state.navigationBytes <= 8 * 1024 * 1024);
  assert.ok(state.navigation.size <= 200);
  assert.equal(state.navigation.has('0'), false);
  assert.equal(state.navigation.has('249'), true);
});

test('unchanged scans retain revisions and update only changed SQLite rows', async (t) => {
  const { root, cache, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'Main.java'), 'class Main {}');
  await fs.writeFile(path.join(root, 'Other.java'), 'class Other {}');
  const index = new WorkspaceIndex({ directory: cache, storage: 'sqlite' });
  t.after(() => index.close());
  const initial = await index.get(project);
  assert.equal((await index.get(project, true)).revision, initial.revision);
  index.store.database.exec('CREATE TABLE index_test_writes(path TEXT); CREATE TRIGGER test_index_update AFTER UPDATE ON workspace_index_files BEGIN INSERT INTO index_test_writes VALUES (NEW.path); END;');
  await fs.writeFile(path.join(root, 'Main.java'), 'class Main { int change; }');
  await index.get(project, true);
  assert.deepEqual(index.store.database.prepare('SELECT path FROM index_test_writes').all().map(row => row.path), ['Main.java']);
});
