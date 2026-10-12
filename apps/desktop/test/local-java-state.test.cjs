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

test('evaluation validates a current pause and frame, sanitizes DAP arguments and rejects late results', async () => {
  const runtime = new LocalJavaRuntime({}); const project = { id: 'project' }; const calls = [];
  const session = { id: 'session', stopVersion: 2, status: 'paused', mode: 'debug', frames: [{ id: 11 }], dap: { request: async (command, args) => { calls.push({ command, args }); return { result: '43', type: 'int', variablesReference: 0 }; } } };
  runtime.sessions.set(project.id, session);
  const input = { sessionId: 'session', stopVersion: 2, frameId: 11, expression: 'answer + 1', context: 'repl', arbitrary: 'ignored' };
  for (const patch of [{ sessionId: undefined }, { stopVersion: 1 }, { sessionId: 'old' }, { frameId: 12 }, { expression: '' }, { expression: '\0' }, { expression: 'x'.repeat(4001) }]) await assert.rejects(runtime.action(project, 'evaluate', { ...input, ...patch }));
  assert.equal(calls.length, 0);
  assert.deepEqual(await runtime.action(project, 'evaluate', input), { result: '43', type: 'int', variablesReference: 0 });
  assert.deepEqual(calls[0], { command: 'evaluate', args: { frameId: 11, expression: 'answer + 1', context: 'watch' } });
  session.dap.request = async () => { session.stopVersion++; return { result: 'stale' }; };
  await assert.rejects(runtime.action(project, 'evaluate', input), /暂停位置已变化/);
  session.status = 'running'; await assert.rejects(runtime.action(project, 'evaluate', { ...input, stopVersion: 3 }), /暂停/);
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
test('thread selection refreshes its stack, advances pause identity and invalidates old variables', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-threads-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Worker.java'), 'class Worker {}');
  const runtime = new LocalJavaRuntime({}); const project = { id: 'threads', path: root }; const calls = [];
  const session = { id: 'session', stopVersion: 1, status: 'paused', mode: 'debug', threadId: 1, frames: [{ id: 11 }], logs: [], dap: { request: async (command, input) => {
    calls.push({ command, input });
    if (command === 'threads') return { threads: [{ id: 1, name: 'main' }, { id: 2, name: 'worker' }] };
    if (command === 'stackTrace') return { stackFrames: [{ id: 22, name: 'Worker.run()', line: 1, column: 1, source: { path: path.join(root, 'Worker.java') } }] };
    return {};
  } } };
  runtime.sessions.set(project.id, session);
  for (const input of [{ threadId: 2 }, { threadId: '2', sessionId: 'session', stopVersion: 1 }, { threadId: 2, sessionId: 'old', stopVersion: 1 }]) await assert.rejects(runtime.action(project, 'selectThread', input));
  assert.equal(calls.length, 0);
  const selected = await runtime.action(project, 'selectThread', { threadId: 2, sessionId: 'session', stopVersion: 1 });
  assert.equal(selected.status, 'paused'); assert.equal(selected.threadId, 2); assert.equal(selected.stopVersion, 2);
  assert.equal(selected.frames[0].path, 'Worker.java'); assert.equal(selected.frames[0].id, 22); assert.equal(selected.framesLoading, false);
  assert.deepEqual(calls[1], { command: 'stackTrace', input: { threadId: 2, startFrame: 0, levels: 50 } });
  await assert.rejects(runtime.action(project, 'variables', { sessionId: 'session', stopVersion: 1, variablesReference: 12 }), /暂停位置/);
  await assert.rejects(runtime.action(project, 'selectThread', { threadId: 99, sessionId: 'session', stopVersion: 2 }), /不存在/);
  assert.equal(session.threadId, 2); assert.equal(session.frames[0].id, 22);
});
test('late thread/stack responses cannot overwrite a new stop or resumed session', async () => {
  const runtime = new LocalJavaRuntime({}); const project = { id: 'race', path: os.tmpdir() };
  const session = { id: 'session', stopVersion: 1, status: 'paused', mode: 'debug', threadId: 1, frames: [{ id: 11 }], logs: [], dap: { request: async command => {
    if (command === 'threads') return { threads: [{ id: 2, name: 'worker' }] };
    session.stopVersion++; session.frames = [{ id: 99 }]; session.framesLoading = false; return { stackFrames: [{ id: 22 }] };
  } } };
  runtime.sessions.set(project.id, session);
  await assert.rejects(runtime.action(project, 'selectThread', { threadId: 2, sessionId: 'session', stopVersion: 1 }), /暂停位置/);
  assert.equal(session.frames[0].id, 99); assert.equal(session.framesLoading, false);
  session.dap.request = async () => { session.status = 'running'; return { threads: [{ id: 8 }] }; };
  await assert.rejects(runtime.action(project, 'threads', { sessionId: 'session', stopVersion: 3 }), /暂停位置/);
});
test('failed thread stack requests leave no previous-thread frames and lists report clipping', async () => {
  const runtime = new LocalJavaRuntime({}); const project = { id: 'failed', path: os.tmpdir() };
  const session = { id: 'session', stopVersion: 1, status: 'paused', mode: 'debug', threadId: 1100, frames: [{ id: 11 }], logs: [], dap: { request: async command => {
    if (command === 'threads') return { threads: Array.from({ length: 1100 }, (_, index) => ({ id: index + 1, name: 'x'.repeat(600) })) };
    throw new Error('thread no longer suspended');
  } } };
  runtime.sessions.set(project.id, session);
  const listing = await runtime.action(project, 'threads');
  assert.equal(listing.threads.length, 1000); assert.equal(listing.threadsTruncated, true); assert.ok(listing.threads.some(thread => thread.id === 1100)); assert.equal(listing.threads[0].name.length, 500);
  await assert.rejects(runtime.action(project, 'selectThread', { threadId: 2, sessionId: 'session', stopVersion: 1 }), /no longer suspended/);
  assert.deepEqual(session.frames, []); assert.equal(session.framesLoading, false); assert.match(session.framesError, /no longer suspended/);
});
test('continuing one thread retains other paused stacks; explicit continueAll clears suspension', async () => {
  const runtime = new LocalJavaRuntime({}); const project = { id: 'partial', path: os.tmpdir() }; const calls = [];
  const session = { id: 'session', stopVersion: 1, status: 'paused', mode: 'debug', threadId: 2, pausedThreads: new Set([1, 2]), frames: [{ id: 22 }], logs: [], dap: { request: async (command, input) => {
    calls.push({ command, input });
    if (command === 'threads') return { threads: [{ id: 1, name: 'main' }, { id: 2, name: 'worker' }] };
    if (command === 'stackTrace') return { stackFrames: [{ id: 11, name: 'main', line: 1 }] };
    return { allThreadsContinued: false };
  } } };
  runtime.sessions.set(project.id, session);
  const partial = await runtime.action(project, 'continue');
  assert.equal(partial.status, 'paused'); assert.equal(partial.threadId, 1); assert.deepEqual(partial.pausedThreadIds, [1]); assert.equal(partial.frames[0].id, 11);
  const resumed = await runtime.action(project, 'continueAll');
  assert.equal(resumed.status, 'running'); assert.deepEqual(resumed.pausedThreadIds, []); assert.deepEqual(resumed.frames, []);
  assert.ok(calls.some(call => call.command === 'continueAll' && call.input.threadId === 1));
});
test('explicit pause uses only the validated selected thread and rejects stale choices before DAP', async () => {
  const runtime = new LocalJavaRuntime({}); const project = { id: 'pause' }; const calls = [];
  const session = { id: 'session', stopVersion: 2, status: 'paused', mode: 'debug', threadId: 1, frames: [], dap: { request: async (command, input) => {
    calls.push({ command, input }); return { threads: [{ id: 1 }, { id: 2 }] };
  } } };
  runtime.sessions.set(project.id, session);
  await assert.rejects(runtime.action(project, 'pause', { threadId: 2, sessionId: 'session', stopVersion: 1 })); assert.equal(calls.length, 0);
  await runtime.action(project, 'pause', { threadId: 2, sessionId: 'session', stopVersion: 2 });
  assert.deepEqual(calls.at(-1), { command: 'pause', input: { threadId: 2 } });
  await assert.rejects(runtime.action(project, 'pause', { threadId: 3, sessionId: 'session', stopVersion: 2 }));
});
test('omitted allThreadsContinued on continue means all threads resumed', async () => {
  const runtime = new LocalJavaRuntime({}); const project = { id: 'defaults' };
  const session = { id: 'session', status: 'paused', mode: 'debug', stopVersion: 1, threadId: 2, pausedThreads: new Set([1, 2]), frames: [{ id: 22 }], dap: { request: async () => ({}) } };
  runtime.sessions.set(project.id, session);
  const result = await runtime.action(project, 'continue'); assert.equal(result.status, 'running'); assert.deepEqual(result.pausedThreadIds, []);
});
