const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLocalApi } = require('../src/local-api.cjs');
const { LocalStore } = require('../src/local-store.cjs');
const { JavaRunConfigurationStore, validateConfiguration, validateCollection } = require('../src/java-run-configuration.cjs');

function testCodec() {
  const key = crypto.randomBytes(32);
  return {
    available: () => true,
    encrypt(value) {
      const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64');
    },
    decrypt(value) {
      const data = Buffer.from(value, 'base64'); const cipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString();
    },
  };
}
test('run configuration validation bounds parameters and strips untrusted execution fields', () => {
  assert.deepEqual(validateConfiguration({ mainClass: 'demo.Main', mode: 'debug', cwd: '/other', args: 'hello' }), { mainClass: 'demo.Main', args: 'hello', vmArgs: '' });
  for (const input of [null, [], {}, { mainClass: 'demo.Main\n' }, { mainClass: 'demo.Main', args: '\0' }, { mainClass: 'demo.Main', vmArgs: 3 }, { mainClass: 'demo.Main', args: 'a'.repeat(8001) }, { mainClass: 'demo.Main', projectName: {} }]) assert.throws(() => validateConfiguration(input), { code: 'LOCAL_JAVA_CONFIGURATION_INVALID' });
});
test('run configuration fails closed when credential encryption is unavailable or ciphertext is corrupt', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-config-store-')); const store = new LocalStore(path.join(directory, 'local.sqlite3'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const project = { id: 'project-1' }; const configuration = { mainClass: 'demo.Main' };
  const unavailable = new JavaRunConfigurationStore(store, { available: () => false });
  assert.equal(unavailable.read(project), null);
  assert.throws(() => unavailable.save(project, configuration), { code: 'LOCAL_CREDENTIAL_STORE_UNAVAILABLE' });
  assert.equal(store.getSetting(unavailable.key(project)), undefined);
  const available = new JavaRunConfigurationStore(store, testCodec()); available.save(project, configuration);
  assert.throws(() => unavailable.read(project), { code: 'LOCAL_CREDENTIAL_STORE_UNAVAILABLE' });
  store.setSetting(available.key(project), 'corrupt');
  assert.throws(() => available.read(project), { code: 'LOCAL_JAVA_CONFIGURATION_INVALID' });
  unavailable.remove(project); assert.equal(available.read(project), null);
});
test('Local API saves encrypted per-project Java configuration and restores after a restart without login', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-config-api-')); const storePath = path.join(directory, 'local.sqlite3');
  const first = path.join(directory, 'first'); const second = path.join(directory, 'second'); fs.mkdirSync(first); fs.mkdirSync(second);
  const codec = testCodec(); const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  let api;
  t.after(async () => { await api?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const start = () => createLocalApi({ token: 'test-token', storePath, credentialCodec: codec });
  api = await start(); const project = api.registerWorkspace(first); const other = api.registerWorkspace(second);
  const url = (id = project.id) => `${api.origin}/api/local/projects/${id}/java-run/configuration`;
  const configuration = { mainClass: 'demo.Main', projectName: 'demo', args: '--password=secret-value-for-test', vmArgs: '-Xmx512m -Dfeature=on' };
  assert.equal((await fetch(url())).status, 401);
  assert.equal((await fetch(url('a'.repeat(24)), { headers })).status, 404);
  assert.deepEqual(await (await fetch(url(), { headers })).json(), { configuration: null });
  const saved = await fetch(url(), { method: 'POST', headers, body: JSON.stringify(configuration) }); assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { configuration });
  assert.deepEqual(await (await fetch(url(other.id), { headers })).json(), { configuration: null });
  const invalid = await fetch(url(), { method: 'POST', headers, body: JSON.stringify({ ...configuration, args: 'a'.repeat(8001) }) }); assert.equal(invalid.status, 400);
  await api.close(); api = null;
  const store = new LocalStore(storePath); const ciphertext = store.getSetting(`java.runConfiguration.${project.id}`);
  assert.equal(typeof ciphertext, 'string'); assert.ok(!ciphertext.includes('secret-value-for-test')); assert.deepEqual(JSON.parse(codec.decrypt(ciphertext)), configuration); store.close();
  for (const name of fs.readdirSync(directory).filter((name) => name.startsWith('local.sqlite3'))) assert.ok(!fs.readFileSync(path.join(directory, name)).includes(Buffer.from('secret-value-for-test')));
  api = await start(); assert.deepEqual(await (await fetch(url(), { headers })).json(), { configuration });
  assert.equal((await fetch(url(), { method: 'DELETE', headers })).status, 200);
  assert.deepEqual(await (await fetch(url(), { headers })).json(), { configuration: null });
});
test('named configuration validation rejects duplicate names, IDs, invalid selection and unbounded collections', () => {
  const item = { id: 'a', name: '开发环境', mainClass: 'demo.Main', args: 'hello', cwd: '/untrusted' };
  assert.deepEqual(validateCollection({ selectedId: 'a', configurations: [item] }), { selectedId: 'a', configurations: [{ id: 'a', name: '开发环境', mainClass: 'demo.Main', args: 'hello', vmArgs: '' }] });
  for (const configurations of [[{ ...item, name: '' }], [{ ...item, name: 'x\n' }], [{ ...item, name: 'x'.repeat(81) }], [item, { ...item, id: 'b' }], [item, { ...item, name: 'Other' }], Array.from({ length: 21 }, (_, i) => ({ ...item, id: `id${i}`, name: `n${i}` }))]) assert.throws(() => validateCollection({ selectedId: 'a', configurations }), { code: 'LOCAL_JAVA_CONFIGURATION_INVALID' });
  assert.throws(() => validateCollection({ selectedId: 'absent', configurations: [item] }));
  assert.throws(() => validateCollection({ selectedId: 'a', configurations: [] }));
});
test('named configurations migrate legacy encrypted settings only on mutation and preserve independent profiles', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-profiles-store-'));
  const store = new LocalStore(path.join(directory, 'store.sqlite3'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const codec = testCodec(); const configurations = new JavaRunConfigurationStore(store, codec); const project = { id: 'project' };
  const legacy = configurations.save(project, { mainClass: 'demo.Main', args: 'legacy-password' });
  assert.equal(configurations.list(project).configurations[0].id, 'legacy');
  assert.equal(store.getSetting(configurations.collectionKey(project)), undefined);
  const created = configurations.mutate(project, { operation: 'save', name: '生产', mainClass: 'demo.Main', args: 'prod-password' });
  assert.equal(created.configurations.length, 2); assert.equal(store.getSetting(configurations.key(project)), undefined);
  assert.ok(!store.getSetting(configurations.collectionKey(project)).includes('prod-password'));
  assert.equal(configurations.read(project).args, 'prod-password');
  configurations.mutate(project, { operation: 'select', id: 'legacy' }); assert.deepEqual(configurations.read(project), legacy);
  configurations.save(project, { ...legacy, vmArgs: '-Xmx512m' }); assert.equal(configurations.list(project).configurations.length, 2);
  const before = store.getSetting(configurations.collectionKey(project));
  assert.throws(() => configurations.mutate(project, { operation: 'save', name: '生产', mainClass: 'demo.Main' }));
  assert.throws(() => configurations.mutate(project, { operation: 'remove', id: 'missing' }));
  assert.equal(store.getSetting(configurations.collectionKey(project)), before);
  const { JavaBreakpointConfigurationStore } = require('../src/java-breakpoint-configuration.cjs');
  const breakpoints = new JavaBreakpointConfigurationStore(store, codec); breakpoints.save(project, { 'Main.java': [4] }); breakpoints.remove(project);
  assert.equal(store.getSetting(configurations.collectionKey(project)), before, 'breakpoint clear must not delete profiles');
  configurations.mutate(project, { operation: 'remove', id: 'legacy' }); assert.equal(configurations.read(project).args, 'prod-password');
  configurations.mutate(project, { operation: 'remove', id: created.selectedId }); assert.equal(configurations.read(project), null);
  store.setSetting(configurations.collectionKey(project), 'corrupt');
  assert.throws(() => configurations.mutate(project, { operation: 'save', name: 'new', mainClass: 'demo.Main' }));
  assert.equal(store.getSetting(configurations.collectionKey(project)), 'corrupt');
});
test('named profiles restore selected credentials across API restart with project isolation and no login', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-profiles-api-'));
  const root = path.join(directory, 'project'); const otherRoot = path.join(directory, 'other'); fs.mkdirSync(root); fs.mkdirSync(otherRoot);
  const codec = testCodec(); const options = { token: 'test-token', storePath: path.join(directory, 'store.sqlite3'), credentialCodec: codec };
  let api = await createLocalApi(options);
  t.after(async () => { await api.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const project = api.registerWorkspace(root); const other = api.registerWorkspace(otherRoot);
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const url = id => `${api.origin}/api/local/projects/${id || project.id}/java-run/configurations`;
  const mutate = async input => { const response = await fetch(url(), { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(response.status, 200); return response.json(); };
  assert.equal((await fetch(url())).status, 401);
  assert.deepEqual(await (await fetch(url(), { headers })).json(), { selectedId: null, configurations: [] });
  const a = await mutate({ operation: 'save', name: '开发', mainClass: 'demo.Main', args: 'dev-password' });
  const b = await mutate({ operation: 'save', name: '生产', mainClass: 'demo.Main', args: 'prod-password' });
  await mutate({ operation: 'select', id: a.selectedId });
  assert.deepEqual(await (await fetch(url(other.id), { headers })).json(), { selectedId: null, configurations: [] });
  await api.close(); api = await createLocalApi(options);
  const restored = await (await fetch(url(), { headers })).json(); assert.equal(restored.selectedId, a.selectedId); assert.equal(restored.configurations.length, 2);
  assert.equal((await mutate({ operation: 'remove', id: a.selectedId })).selectedId, b.selectedId);
  for (const name of fs.readdirSync(directory).filter(name => name.startsWith('store.sqlite3'))) {
    const data = fs.readFileSync(path.join(directory, name)); assert.ok(!data.includes(Buffer.from('dev-password'))); assert.ok(!data.includes(Buffer.from('prod-password')));
  }
});
