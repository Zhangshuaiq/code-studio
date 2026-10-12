const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
const { createLocalApi } = require('../src/local-api.cjs');
const { LocalJavaRuntime } = require('../src/local-java-runtime.cjs');
const { LocalStore } = require('../src/local-store.cjs');
const { JavaBreakpointConfigurationStore, validateBreakpoints } = require('../src/java-breakpoint-configuration.cjs');

test('breakpoints normalize bounded project Java paths and reject invalid snapshots', () => {
  assert.deepEqual(validateBreakpoints({ 'src/中文.java': [9, 2, 9], 'Empty.java': [] }), { 'src/中文.java': [2, 9] });
  for (const value of [null, [], { '/Main.java': [1] }, { '../Main.java': [1] }, { 'C:/Main.java': [1] }, { 'src\\Main.java': [1] }, { '@java-source/a/Main.java': [1] }, { 'Main.txt': [1] }, { 'Main.java': [0] }, { 'Main.java': [1.5] }, { 'Main.java': ['1'] }, { 'Main.java': Array(1001).fill(1) }, Object.fromEntries(Array.from({ length: 201 }, (_, n) => [`Main${n}.java`, [1]]))]) assert.throws(() => validateBreakpoints(value), { code: 'LOCAL_JAVA_BREAKPOINTS_INVALID' });
});

test('DAP clears removed sources including the last breakpoint', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-breakpoints-dap-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Main.java'), 'class Main {}');
  const calls = []; const session = { dap: { request: async (command, body) => { calls.push({ command, body }); return { breakpoints: body.breakpoints.map(p => ({ ...p, verified: true })) }; } } };
  const runtime = new LocalJavaRuntime({}); const project = { path: root };
  await runtime.setBreakpoints(project, session, { 'Main.java': [1] });
  await runtime.setBreakpoints(project, session, {});
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].body.breakpoints, []); assert.equal(calls[1].body.source.path, fs.realpathSync(path.join(root, 'Main.java')));
  assert.deepEqual(session.breakpoints, []); assert.deepEqual(session.breakpointSources, []);
});

test('conditional breakpoints normalize safely and require DAP capability before sending', async t => {
  assert.deepEqual(validateBreakpoints({ 'Main.java': [1, { line: 3, condition: ' i == 2 ', command: 'ignored' }, { line: 1, condition: ' ' }] }), { 'Main.java': [1, { line: 3, condition: 'i == 2' }] });
  for (const condition of [null, 1, '\0', 'x'.repeat(2001)]) assert.throws(() => validateBreakpoints({ 'Main.java': [{ line: 1, condition }] }), { code: 'LOCAL_JAVA_BREAKPOINTS_INVALID' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-condition-dap-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Main.java'), 'class Main {}');
  const calls = []; const session = { dap: { request: async (_name, body) => { calls.push(body); return { breakpoints: body.breakpoints.map(p => ({ line: p.line, verified: true })) }; } } };
  const runtime = new LocalJavaRuntime({}); const project = { path: root };
  await assert.rejects(runtime.setBreakpoints(project, session, { 'Main.java': [{ line: 1, condition: 'i == 2' }] }), { code: 'LOCAL_JAVA_CONDITIONAL_BREAKPOINT_UNSUPPORTED' });
  assert.equal(calls.length, 0);
  session.capabilities = { supportsConditionalBreakpoints: true };
  await runtime.setBreakpoints(project, session, { 'Main.java': [{ line: 1, condition: 'i == 2' }] });
  assert.deepEqual(calls[0].breakpoints, [{ line: 1, condition: 'i == 2' }]);
  assert.equal(session.breakpoints[0].condition, 'i == 2');
});

test('unavailable encryption and corrupt breakpoint cache do not silently replace saved data', () => {
  const values = new Map();
  const store = { getSetting: key => values.get(key), setSetting: (key, value) => values.set(key, value), deleteSetting: key => values.delete(key) };
  const project = { id: 'fixture' };
  const unavailable = new JavaBreakpointConfigurationStore(store, { available: () => false });
  assert.deepEqual(unavailable.read(project), {});
  assert.throws(() => unavailable.save(project, { 'Main.java': [1] }), { code: 'LOCAL_CREDENTIAL_STORE_UNAVAILABLE' });
  assert.equal(values.size, 0);
  values.set(unavailable.key(project), 'corrupt');
  const broken = new JavaBreakpointConfigurationStore(store, { available: () => true, decrypt: () => { throw new Error('invalid ciphertext'); } });
  assert.throws(() => broken.read(project), { code: 'LOCAL_JAVA_BREAKPOINTS_INVALID' });
  assert.equal(values.get(unavailable.key(project)), 'corrupt');
  broken.remove(project); assert.deepEqual(broken.read(project), {});
});

test('hit counts and logpoints validate, require independent capabilities and preserve DAP fields', async t => {
  const point = { line: 1, hitCondition: '3', logMessage: ' trace:{i} ', extraCommand: 'ignored' };
  assert.deepEqual(validateBreakpoints({ 'Main.java': [point] }), { 'Main.java': [{ line: 1, hitCondition: '3', logMessage: ' trace:{i} ' }] });
  for (const hitCondition of ['0', '-1', '1.5', '>5', '%2', '2147483648', 3, '\0']) assert.throws(() => validateBreakpoints({ 'Main.java': [{ line: 1, hitCondition }] }), { code: 'LOCAL_JAVA_BREAKPOINTS_INVALID' });
  for (const logMessage of [null, 3, '\0', 'x'.repeat(2001)]) assert.throws(() => validateBreakpoints({ 'Main.java': [{ line: 1, logMessage }] }), { code: 'LOCAL_JAVA_BREAKPOINTS_INVALID' });
  assert.deepEqual(validateBreakpoints({ 'Main.java': [{ line: 1, hitCondition: ' ', logMessage: ' ' }] }), { 'Main.java': [1] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-logpoint-dap-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Main.java'), 'class Main {}');
  const calls = []; const session = { capabilities: {}, dap: { request: async (_name, body) => { calls.push(body); return { breakpoints: body.breakpoints.map(p => ({ line: p.line, verified: true })) }; } } };
  const runtime = new LocalJavaRuntime({}); const project = { path: root };
  await assert.rejects(runtime.setBreakpoints(project, session, { 'Main.java': [point] }), { code: 'LOCAL_JAVA_HIT_BREAKPOINT_UNSUPPORTED' });
  session.capabilities.supportsHitConditionalBreakpoints = true;
  await assert.rejects(runtime.setBreakpoints(project, session, { 'Main.java': [point] }), { code: 'LOCAL_JAVA_LOGPOINT_UNSUPPORTED' });
  assert.equal(calls.length, 0); session.capabilities.supportsLogPoints = true;
  await runtime.setBreakpoints(project, session, { 'Main.java': [point] });
  assert.deepEqual(calls[0].breakpoints, [{ line: 1, hitCondition: '3', logMessage: ' trace:{i} ' }]);
  assert.equal(session.breakpoints[0].hitCondition, '3'); assert.equal(session.breakpoints[0].logMessage, ' trace:{i} ');
});

test('concurrent DAP breakpoint snapshots serialize and a failed update does not poison the queue', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-breakpoints-race-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Main.java'), 'class Main {}');
  let release; const blocked = new Promise(resolve => { release = resolve; }); const calls = [];
  const session = { dap: { request: async (_command, body) => {
    calls.push(body.breakpoints.map(point => point.line));
    if (calls.length === 1) await blocked;
    if (body.breakpoints.some(point => point.line === 99)) throw new Error('fixture DAP failure');
    return { breakpoints: body.breakpoints.map(point => ({ ...point, verified: true })) };
  } } };
  const runtime = new LocalJavaRuntime({}); const project = { path: root };
  const first = runtime.setBreakpoints(project, session, { 'Main.java': [1] });
  const lines = [2]; const second = runtime.setBreakpoints(project, session, { 'Main.java': lines });
  lines.push(3); // The queued request must own its input snapshot.
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [[1]]);
  release(); await Promise.all([first, second]); assert.deepEqual(calls, [[1], [2]]);
  assert.equal(session.breakpoints[0].line, 2);
  await assert.rejects(runtime.setBreakpoints(project, session, { 'Main.java': [99] }), /fixture DAP failure/);
  await runtime.setBreakpoints(project, session, {}); assert.deepEqual(calls.at(-1), []); assert.deepEqual(session.breakpoints, []);
});

test('saved breakpoints restore per project across Local API restart without login or language startup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-breakpoints-api-')); const storePath = path.join(root, 'store.sqlite3');
  const first = path.join(root, 'first'); const second = path.join(root, 'second'); fs.mkdirSync(first); fs.mkdirSync(second);
  const key = crypto.randomBytes(32);
  const codec = { available: () => true, encrypt(value) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]).toString('base64'); }, decrypt(value) { const bytes = Buffer.from(value, 'base64'); const c = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); c.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString(); } };
  let api; t.after(async () => { await api?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const start = () => createLocalApi({ token: 'fixture-token', storePath, credentialCodec: codec });
  api = await start(); const project = api.registerWorkspace(first); const other = api.registerWorkspace(second);
  const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' };
  const url = (id = project.id) => `${api.origin}/api/local/projects/${id}/java-run/breakpoint-configuration`;
  assert.equal((await fetch(url())).status, 401);
  assert.deepEqual(await (await fetch(url(), { headers })).json(), { breakpoints: {} });
  const points = { 'src/PrivateBusinessLogic.java': [4, { line: 9, condition: 'secretValue == 42', hitCondition: '3', logMessage: 'trace:{secretValue}' }] };
  assert.equal((await fetch(url(), { method: 'POST', headers, body: JSON.stringify({ breakpoints: points }) })).status, 200);
  assert.deepEqual(await (await fetch(url(other.id), { headers })).json(), { breakpoints: {} });
  assert.equal((await fetch(url(), { method: 'POST', headers, body: JSON.stringify({ breakpoints: { '../Main.java': [1] } }) })).status, 400);
  await api.close(); api = null;
  const store = new LocalStore(storePath); const saved = new JavaBreakpointConfigurationStore(store, codec);
  assert.deepEqual(saved.read(project), points);
  assert.throws(() => new JavaBreakpointConfigurationStore(store, { available: () => false }).read(project), { code: 'LOCAL_CREDENTIAL_STORE_UNAVAILABLE' });
  store.close();
  for (const name of fs.readdirSync(root).filter(name => name.startsWith('store.sqlite3'))) assert.equal(fs.readFileSync(path.join(root, name)).includes(Buffer.from('PrivateBusinessLogic')), false);
  api = await start(); assert.deepEqual(await (await fetch(url(), { headers })).json(), { breakpoints: points });
  assert.equal((await fetch(url(), { method: 'DELETE', headers })).status, 200);
  assert.deepEqual(await (await fetch(url(), { headers })).json(), { breakpoints: {} });
});
