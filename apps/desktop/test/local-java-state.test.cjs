const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { LocalJavaRuntime, debugSourcePath } = require('../src/local-java-runtime.cjs');

test('debug sources accept native paths, file URIs and real paths but reject outside sources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-source-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'My File.java'); fs.writeFileSync(file, 'class Test {}');
  const outside = path.join(root, '..', 'outside.java');
  assert.equal(debugSourcePath(root, file), 'My File.java');
  assert.equal(debugSourcePath(root, pathToFileURL(file).href), 'My File.java');
  assert.equal(debugSourcePath(root, 'My File.java'), 'My File.java');
  assert.equal(debugSourcePath(root, fs.realpathSync(file)), 'My File.java');
  assert.equal(debugSourcePath(root, outside), null);
  assert.equal(debugSourcePath(root, 'jdt://contents/Other.class'), null);
});

test('a stopped event preceding the step response is not overwritten; stale variable references are rejected', async () => {
  const runtime = new LocalJavaRuntime({});
  const session = { id: 'session-1', stopVersion: 1, status: 'paused', mode: 'debug', threadId: 7, frames: [{ id: 11, line: 5 }], logs: [], breakpoints: [], dap: { request: async () => {
    session.stopVersion++; session.status = 'paused'; session.frames = [{ id: 11, line: 6 }]; return {};
  } } };
  runtime.sessions.set('project', session);
  const project = { id: 'project' };
  const state = await runtime.action(project, 'next');
  assert.equal(state.status, 'paused'); assert.equal(state.frames[0].line, 6); assert.equal(state.stopVersion, 2);
  await assert.rejects(runtime.action(project, 'variables', { variablesReference: 99, sessionId: 'session-1', stopVersion: 1 }), /暂停位置已变化/);
  // Even older clients without version fields must not receive an async scope
  // response from a pause that has already been superseded.
  await assert.rejects(runtime.action(project, 'scopes', { frameId: 11 }), /暂停位置已变化/);
});
