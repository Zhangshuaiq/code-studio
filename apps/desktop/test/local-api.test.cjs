const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ExcelJS = require('exceljs');
const test = require('node:test');
const { createLocalApi } = require('../src/local-api.cjs');

function signLicense(privateKey, payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

test('Local API binds loopback and requires its startup token', async (t) => {
  const api = await createLocalApi({ token: 'test-token' });
  t.after(() => api.close());
  assert.match(api.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  const unauthorized = await fetch(`${api.origin}/api/local/health`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${api.origin}/api/local/health`, {
    headers: { Authorization: 'Bearer test-token', Origin: api.origin },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ready',
    runtime: 'desktop-local',
    edition: 'community',
    remoteApiRequired: false,
  });
  const capabilities = await fetch(`${api.origin}/api/local/capabilities`, { headers: { Authorization: 'Bearer test-token', Origin: api.origin } });
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), {
    edition: 'community', accountRequired: false, licenseRequired: false, coreAccessExpiresAt: null, remoteApiRequired: false,
    capabilities: { projects: true, files: true, git: true, terminal: true, preview: true, localAgent: true, search: true, codeNavigation: true, connectors: true, cloudSync: false, teamWorkspace: false, enterpriseGovernance: false },
  });
});

test('Local API rejects foreign browser origins even with a valid token', async (t) => {
  const api = await createLocalApi({ token: 'test-token' });
  t.after(() => api.close());
  const response = await fetch(`${api.origin}/api/local/health`, {
    headers: { Authorization: 'Bearer test-token', Origin: 'https://attacker.example' },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'LOCAL_API_ORIGIN_REJECTED');
});

test('signed device license enables only entitled features and removal preserves local core capabilities', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-license-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519');
  const now = Math.floor(Date.now() / 1000);
  const deviceId = 'test-device';
  const api = await createLocalApi({
    token: 'test-token', storePath: path.join(directory, 'local.sqlite3'),
    deviceId, licensePublicKey: keys.publicKey, licenseNow: now * 1000,
  });
  t.after(() => api.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const unsignedCapabilities = await (await fetch(`${api.origin}/api/local/capabilities`, { headers })).json();
  assert.equal(unsignedCapabilities.edition, 'community');
  assert.equal(unsignedCapabilities.capabilities.projects, true);
  assert.equal(unsignedCapabilities.capabilities.cloudSync, false);

  const wrongDevice = signLicense(keys.privateKey, { sub: 'user-1', deviceId: 'another-device', edition: 'personal-pro', iat: now - 60, exp: now + 3600, graceUntil: now + 7200, entitlements: ['cloud.sync'] });
  const rejected = await fetch(`${api.origin}/api/local/license`, { method: 'POST', headers, body: JSON.stringify({ token: wrongDevice }) });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, 'LOCAL_LICENSE_INVALID');

  const valid = signLicense(keys.privateKey, { sub: 'user-1', deviceId, edition: 'personal-pro', iat: now - 60, exp: now + 3600, graceUntil: now + 7200, entitlements: ['cloud.sync'] });
  const installed = await fetch(`${api.origin}/api/local/license`, { method: 'POST', headers, body: JSON.stringify({ token: valid }) });
  assert.equal(installed.status, 200);
  assert.equal((await installed.json()).state, 'active');
  const paidCapabilities = await (await fetch(`${api.origin}/api/local/capabilities`, { headers })).json();
  assert.equal(paidCapabilities.edition, 'personal-pro');
  assert.equal(paidCapabilities.capabilities.cloudSync, true);
  assert.equal(paidCapabilities.capabilities.projects, true);
  assert.equal(paidCapabilities.capabilities.teamWorkspace, false);

  const privacyBefore = await (await fetch(`${api.origin}/api/local/privacy`, { headers })).json();
  assert.equal(privacyBefore.settingsSync, false);
  assert.equal(privacyBefore.conversationSync, false);
  assert.equal(privacyBefore.sourceCodeSync, false);
  assert.equal(privacyBefore.cloudSyncAvailable, true);
  const privacySaved = await fetch(`${api.origin}/api/local/privacy`, { method: 'PUT', headers, body: JSON.stringify({ settingsSync: true, conversationSync: true }) });
  assert.equal(privacySaved.status, 200);
  const privacyBody = await privacySaved.json();
  assert.equal(privacyBody.settingsSync, true);
  assert.equal(privacyBody.conversationSync, true);
  assert.equal(privacyBody.audit.length, 2);

  const removed = await fetch(`${api.origin}/api/local/license`, { method: 'DELETE', headers });
  assert.equal(removed.status, 204);
  const degraded = await (await fetch(`${api.origin}/api/local/capabilities`, { headers })).json();
  assert.equal(degraded.edition, 'community');
  assert.equal(degraded.capabilities.cloudSync, false);
  assert.equal(degraded.capabilities.projects, true);
  const deniedSync = await fetch(`${api.origin}/api/local/privacy`, { method: 'PUT', headers, body: JSON.stringify({ settingsSync: true, conversationSync: true }) });
  assert.equal(deniedSync.status, 403);
  const status = await (await fetch(`${api.origin}/api/local/license`, { headers })).json();
  assert.equal(status.state, 'none');
  assert.equal(status.deviceId, deviceId);
});

test('team and enterprise license entitlements map to desktop capabilities', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-edition-capabilities-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519'); const deviceId = 'edition-device-00000001'; const now = Math.floor(Date.now() / 1000);
  const api = await createLocalApi({ token: 'test-token', storePath: path.join(directory, 'local.sqlite3'), deviceId, licensePublicKey: keys.publicKey }); t.after(() => api.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const enterprise = signLicense(keys.privateKey, { sub: 'user-1', deviceId, edition: 'enterprise', iat: now, exp: now + 3600, graceUntil: now + 7200, entitlements: ['cloud.sync', 'remote.execution', 'team.collaboration', 'enterprise.rbac', 'enterprise.audit', 'enterprise.policies'] });
  assert.equal((await fetch(`${api.origin}/api/local/license`, { method: 'POST', headers, body: JSON.stringify({ token: enterprise }) })).status, 200);
  const capabilities = await (await fetch(`${api.origin}/api/local/capabilities`, { headers })).json();
  assert.equal(capabilities.edition, 'enterprise'); assert.equal(capabilities.capabilities.teamWorkspace, true); assert.equal(capabilities.capabilities.enterpriseGovernance, true);
});

test('offline license challenge is device-bound, signed and single-use', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-offline-license-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519'); const deviceId = 'offline-device-00000001'; const now = Math.floor(Date.now() / 1000);
  const api = await createLocalApi({ token: 'test-token', storePath: path.join(directory, 'local.sqlite3'), deviceId, licensePublicKey: keys.publicKey });
  t.after(() => api.close());
  const challenge = api.createOfflineLicenseChallenge();
  assert.equal(challenge.format, 'code-studio-license-request-v1'); assert.equal(challenge.deviceId, deviceId); assert.match(challenge.nonce, /^[A-Za-z0-9_-]{32,128}$/);
  const token = signLicense(keys.privateKey, { sub: 'user-1', deviceId, edition: 'personal-pro', iat: now, exp: now + 3600, graceUntil: now + 7200, entitlements: ['cloud.sync'], challengeNonce: challenge.nonce });
  const responseFile = JSON.stringify({ format: 'code-studio-license-v1', challengeNonce: challenge.nonce, token });
  const installed = api.installOfflineLicenseFile(responseFile);
  assert.equal(installed.state, 'active'); assert.equal(installed.edition, 'personal-pro'); assert.equal(installed.deviceId, deviceId);
  assert.throws(() => api.installOfflineLicenseFile(responseFile), /当前设备申请不匹配/);

  const nextChallenge = api.createOfflineLicenseChallenge();
  const mismatchedToken = signLicense(keys.privateKey, { sub: 'user-1', deviceId, edition: 'personal-pro', iat: now, exp: now + 3600, graceUntil: now + 7200, entitlements: [], challengeNonce: 'different-nonce-value-that-is-long-enough-0000' });
  assert.throws(() => api.installOfflineLicenseFile(JSON.stringify({ format: 'code-studio-license-v1', challengeNonce: nextChallenge.nonce, token: mismatchedToken })), /签名或设备信息无效|申请不匹配/);
});

test('desktop account proxy keeps the access token private and installs a verified device license', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-account-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); let revoked = false; let authorization = ''; let redeemedCode = ''; let invitationToken = '';
  const control = http.createServer((request, response) => {
    const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      response.setHeader('Content-Type', 'application/json'); authorization = request.headers.authorization || '';
      if (request.url === '/api/auth/login') { response.end(JSON.stringify({ accessToken: 'remote-secret-token', user: { id: 'user-1', username: body.username } })); return; }
      if (authorization !== 'Bearer remote-secret-token') { response.statusCode = 401; response.end(JSON.stringify({ message: 'unauthorized' })); return; }
      if (request.url === '/api/control/license/redeem') { redeemedCode = body.code; response.end(JSON.stringify({ edition: 'personal-pro', expiresAt: new Date(Date.now() + 3600_000).toISOString() })); return; }
      if (request.url === '/api/control/enterprise/invitations/accept') { invitationToken = body.token; response.end(JSON.stringify({ organization: { id: 'org-1', name: 'Example Corp' } })); return; }
      if (request.url === '/api/control/license/activate') { const now = Math.floor(Date.now() / 1000); response.end(JSON.stringify({ token: signLicense(privateKey, { sub: 'user-1', deviceId: body.deviceId, edition: 'personal-pro', iat: now, exp: now + 3600, graceUntil: now + 7200, entitlements: ['cloud.sync'] }) })); return; }
      if (request.url === '/api/control/license/devices' && request.method === 'GET') { response.end(JSON.stringify([{ id: '11111111-1111-4111-8111-111111111111', deviceId: 'device-1', name: 'Mac' }])); return; }
      if (request.url === '/api/control/license/devices/11111111-1111-4111-8111-111111111111' && request.method === 'DELETE') { revoked = true; response.end(JSON.stringify({ success: true })); return; }
      response.statusCode = 404; response.end('{}');
    });
  });
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => control.close(resolve)));
  const codec = { available: () => true, encrypt: (value) => Buffer.from(`safe:${value}`).toString('base64'), decrypt: (value) => Buffer.from(value, 'base64').toString().replace(/^safe:/, '') };
  const address = control.address(); const api = await createLocalApi({ token: 'test-token', storePath: path.join(directory, 'local.sqlite3'), credentialCodec: codec, controlServerUrl: `http://127.0.0.1:${address.port}`, licensePublicKey: publicKey, deviceId: 'desktop-device-id-123' }); t.after(() => api.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const login = await fetch(`${api.origin}/api/local/account/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'personal', password: 'password' }) });
  assert.equal(login.status, 200); assert.equal(JSON.stringify(await login.json()).includes('remote-secret-token'), false);
  const account = await (await fetch(`${api.origin}/api/local/account`, { headers })).json(); assert.equal(account.signedIn, true); assert.equal(account.user.username, 'personal');
  const invited = await fetch(`${api.origin}/api/local/account/enterprise/invitations/accept`, { method: 'POST', headers, body: JSON.stringify({ token: 'a'.repeat(43) }) });
  assert.equal(invited.status, 200); assert.equal((await invited.json()).organization.name, 'Example Corp'); assert.equal(invitationToken, 'a'.repeat(43));
  assert.equal((await fetch(`${api.origin}/api/local/account/enterprise/invitations/accept`, { method: 'POST', headers, body: JSON.stringify({ token: 'invalid' }) })).status, 400);
  const redeemed = await fetch(`${api.origin}/api/local/account/license/redeem`, { method: 'POST', headers, body: JSON.stringify({ code: 'CS-TEST-CODE-1234' }) }); assert.equal(redeemed.status, 200); assert.equal(redeemedCode, 'CS-TEST-CODE-1234');
  const activated = await fetch(`${api.origin}/api/local/account/license/activate`, { method: 'POST', headers }); assert.equal(activated.status, 200); assert.equal((await activated.json()).edition, 'personal-pro');
  const devices = await (await fetch(`${api.origin}/api/local/account/devices`, { headers })).json(); assert.equal(devices.items[0].name, 'Mac'); assert.equal(authorization, 'Bearer remote-secret-token');
  const removed = await fetch(`${api.origin}/api/local/account/devices/11111111-1111-4111-8111-111111111111`, { method: 'DELETE', headers }); assert.equal(removed.status, 200); assert.equal(revoked, true);
  await fetch(`${api.origin}/api/local/account`, { method: 'DELETE', headers }); const signedOut = await (await fetch(`${api.origin}/api/local/account`, { headers })).json(); assert.equal(signedOut.signedIn, false); assert.equal(signedOut.license.edition, 'personal-pro');
  assert.equal(fs.readFileSync(path.join(directory, 'local.sqlite3')).includes(Buffer.from('remote-secret-token')), false);
  assert.equal((await fetch(`${api.origin}/api/local/account/enterprise/invitations/accept`, { method: 'POST', headers, body: JSON.stringify({ token: 'a'.repeat(43) }) })).status, 401);
});

test('Local API serves the bundled renderer and authenticates it with an HttpOnly cookie', async (t) => {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-renderer-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Local</title>');
  t.after(() => fs.rmSync(staticDir, { recursive: true, force: true }));
  const api = await createLocalApi({ token: 'cookie-token', staticDir });
  t.after(() => api.close());

  const page = await fetch(api.origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('set-cookie') || '', /code_studio_session=cookie-token; HttpOnly/);
  assert.match(await page.text(), /<title>Local<\/title>/);

  const cookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const projects = await fetch(`${api.origin}/api/local/projects`, {
    headers: { Cookie: cookie, Origin: api.origin },
  });
  assert.equal(projects.status, 200);
  assert.deepEqual(await projects.json(), { items: [] });
});

test('signed enterprise policy is cached and enforced by Local API', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-policy-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519'); const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ organizationId: 'org-1', issuedAt: now - 60, expiresAt: now + 3600, offlineUntil: now + 7200, policy: { terminalEnabled: false, allowedModelEngines: ['codex-cli'], allowedConnectorTypes: ['postgres'], allowedGitHosts: ['github.com'], allowedNetworkHosts: ['127.0.0.1'], minimumClientVersion: '0.1.0' } })).toString('base64url');
  const policyToken = `${header}.${payload}.${crypto.sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`;
  const control = http.createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); if (request.url === '/api/auth/login') response.end(JSON.stringify({ accessToken: 'enterprise-token', user: { id: 'user-1', username: 'enterprise' } })); else if (request.url === '/api/control/enterprise/policy' && request.headers.authorization === 'Bearer enterprise-token') response.end(JSON.stringify({ token: policyToken })); else { response.statusCode = 401; response.end(JSON.stringify({ message: 'unauthorized' })); } });
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => control.close(resolve))); const address = control.address();
  const codec = { available: () => true, encrypt: (value) => Buffer.from(`safe:${value}`).toString('base64'), decrypt: (value) => Buffer.from(value, 'base64').toString().replace(/^safe:/, '') };
  const api = await createLocalApi({ token: 'test-token', storePath: path.join(directory, 'local.sqlite3'), credentialCodec: codec, controlServerUrl: `http://127.0.0.1:${address.port}`, policyPublicKey: keys.publicKey, policyNow: now * 1000, appVersion: '0.1.0' }); t.after(() => api.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${api.origin}/api/local/account/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'enterprise', password: 'password' }) })).status, 200);
  const installed = await fetch(`${api.origin}/api/local/account/enterprise/policy/refresh`, { method: 'POST', headers });
  assert.equal(installed.status, 200); assert.equal((await installed.json()).state, 'active');
  const allowedModel = await fetch(`${api.origin}/api/local/models`, { method: 'POST', headers, body: JSON.stringify({ name: 'Codex', engine: 'codex-cli', provider: 'openai', model: '' }) });
  assert.equal(allowedModel.status, 201);
  const deniedModel = await fetch(`${api.origin}/api/local/models`, { method: 'POST', headers, body: JSON.stringify({ name: 'Local model', engine: 'ollama', provider: 'ollama', model: 'qwen' }) });
  assert.equal(deniedModel.status, 403); assert.equal((await deniedModel.json()).code, 'LOCAL_ENTERPRISE_POLICY_DENIED');
  const deniedConnector = await fetch(`${api.origin}/api/local/connectors`, { method: 'POST', headers, body: JSON.stringify({ name: 'Kafka', type: 'kafka', settings: { brokers: ['127.0.0.1:9092'] } }) });
  assert.equal(deniedConnector.status, 403);
  const deniedNetwork = await fetch(`${api.origin}/api/local/connectors`, { method: 'POST', headers, body: JSON.stringify({ name: 'External DB', type: 'postgres', settings: { host: 'database.forbidden.example', port: 5432, database: 'app', username: 'app' } }) });
  assert.equal(deniedNetwork.status, 403); assert.match((await deniedNetwork.json()).message, /database\.forbidden\.example/);
  const workspace = fs.mkdtempSync(path.join(directory, 'workspace-')); const project = api.registerWorkspace(workspace);
  execFileSync('git', ['init'], { cwd: workspace });
  execFileSync('git', ['remote', 'add', 'origin', 'git@forbidden.example:team/repository.git'], { cwd: workspace });
  const deniedGit = await fetch(`${api.origin}/api/local/projects/${project.id}/git/sync`, { method: 'POST', headers, body: JSON.stringify({ operation: 'fetch', remote: 'origin' }) });
  assert.equal(deniedGit.status, 403); assert.match((await deniedGit.json()).message, /forbidden\.example/);
  const deniedTerminal = await fetch(`${api.origin}/api/local/projects/${project.id}/terminal`, { method: 'POST', headers, body: JSON.stringify({ confirmed: true }) });
  assert.equal(deniedTerminal.status, 403);
  const deniedDebug = await fetch(`${api.origin}/api/local/projects/${project.id}/java-run/start`, { method: 'POST', headers, body: JSON.stringify({ mode: 'debug', mainClass: 'Main' }) });
  assert.equal(deniedDebug.status, 403);
  const status = await (await fetch(`${api.origin}/api/local/enterprise/policy`, { headers })).json();
  assert.equal(status.organizationId, 'org-1'); assert.equal(status.policy.terminalEnabled, false);
});

test('local model configs persist encrypted credentials without returning secrets', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-models-'));
  const databasePath = path.join(directory, 'local.sqlite3');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let authorization = ''; const modelServer = http.createServer((request, response) => { authorization = request.headers.authorization || ''; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'local-model' }, { id: 'other-model' }] })); });
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => modelServer.close(resolve)));
  const address = modelServer.address();
  const codec = { available: () => true, encrypt: (value) => Buffer.from(`protected:${value}`).toString('base64'), decrypt: (value) => Buffer.from(value, 'base64').toString().replace(/^protected:/, '') };
  const api = await createLocalApi({ token: 'test-token', storePath: databasePath, credentialCodec: codec });
  t.after(() => api.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const created = await fetch(`${api.origin}/api/local/models`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Local API', engine: 'openai-compatible', provider: 'custom', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'local-model', apiKey: 'plain-secret' }),
  });
  assert.equal(created.status, 201);
  const model = await created.json();
  assert.equal(model.hasCredential, true);
  assert.equal(model.executionLocation, 'local');
  assert.equal(JSON.stringify(model).includes('plain-secret'), false);
  assert.equal(fs.readFileSync(databasePath).includes(Buffer.from('plain-secret')), false);

  const listed = await fetch(`${api.origin}/api/local/models`, { headers });
  assert.equal((await listed.json()).items[0].name, 'Local API');
  const tested = await fetch(`${api.origin}/api/local/models/${model.id}/test`, { method: 'POST', headers });
  assert.equal(tested.status, 200);
  const diagnostics = await tested.json(); assert.equal(diagnostics.ok, true); assert.equal(diagnostics.configuredModelAvailable, true); assert.deepEqual(diagnostics.models, ['local-model', 'other-model']);
  assert.equal(authorization, 'Bearer plain-secret');
  const removed = await fetch(`${api.origin}/api/local/models/${model.id}`, { method: 'DELETE', headers });
  assert.equal(removed.status, 204);
});

test('connector credentials stay encrypted and Kubernetes connection tests use the device network', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-connectors-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let authorization = ''; const cluster = http.createServer((request, response) => { authorization = request.headers.authorization || ''; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(request.url === '/version' ? { gitVersion: 'v1.test.0' } : { items: [{ metadata: { name: 'api-0' }, status: { phase: 'Running' }, spec: { nodeName: 'node-a' } }] })); });
  await new Promise((resolve) => cluster.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => cluster.close(resolve)));
  const address = cluster.address(); const secret = 'cluster-secret';
  const codec = { available: () => true, encrypt: (value) => Buffer.from(`protected:${value}`).toString('base64'), decrypt: (value) => Buffer.from(value, 'base64').toString().replace(/^protected:/, '') };
  const api = await createLocalApi({ token: 'test-token', storePath: path.join(directory, 'local.sqlite3'), credentialCodec: codec }); t.after(() => api.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const createdResponse = await fetch(`${api.origin}/api/local/connectors`, { method: 'POST', headers, body: JSON.stringify({ name: 'Development Cluster', type: 'kubernetes', settings: { server: `http://127.0.0.1:${address.port}`, namespace: 'default' }, secret }) });
  assert.equal(createdResponse.status, 201); const connector = await createdResponse.json(); assert.equal(connector.hasCredential, true); assert.equal(JSON.stringify(connector).includes(secret), false);
  assert.equal(fs.readFileSync(path.join(directory, 'local.sqlite3')).includes(Buffer.from(secret)), false);
  const tested = await fetch(`${api.origin}/api/local/connectors/${connector.id}/test`, { method: 'POST', headers });
  assert.equal(tested.status, 200); assert.equal((await tested.json()).ok, true); assert.equal(authorization, `Bearer ${secret}`);
  const explored = await fetch(`${api.origin}/api/local/connectors/${connector.id}/explore`, { method: 'POST', headers, body: '{}' });
  assert.equal(explored.status, 200); assert.deepEqual(await explored.json(), { kind: 'resources', items: [{ name: 'api-0', phase: 'Running', node: 'node-a' }] }); assert.equal(authorization, `Bearer ${secret}`);
});

test('Local Agent Runtime executes directly in the workspace and persists events without a worker', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-agent-'));
  const workspace = path.join(directory, 'workspace');
  const fakeAgent = path.join(directory, 'fake-agent');
  fs.mkdirSync(workspace);
  fs.writeFileSync(fakeAgent, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
fs.writeFileSync(path.join(process.cwd(), 'agent-created.txt'), 'local change\\n');
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done locally' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 } }));
if (process.argv.join(' ').includes('slow-task')) setInterval(() => {}, 1000);
`);
  fs.chmodSync(fakeAgent, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = await createLocalApi({ token: 'test-token', storePath: path.join(directory, 'local.sqlite3'), agentCommands: { 'codex-cli': fakeAgent } });
  t.after(() => api.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const project = api.registerWorkspace(workspace);
  const modelResponse = await fetch(`${api.origin}/api/local/models`, { method: 'POST', headers, body: JSON.stringify({ name: 'Fake Codex', engine: 'codex-cli', provider: 'openai', model: '' }) });
  const model = await modelResponse.json();
  const denied = await fetch(`${api.origin}/api/local/projects/${project.id}/agent/tasks`, { method: 'POST', headers, body: JSON.stringify({ modelConfigId: model.id, prompt: 'make a local change', permissionProfile: 'workspace-write' }) });
  assert.equal(denied.status, 403);
  const writeRequest = { projectId: project.id, modelConfigId: model.id, prompt: 'make a local change' };
  const approvalToken = api.issueAgentWriteApproval(writeRequest); assert.ok(approvalToken);
  const started = await fetch(`${api.origin}/api/local/projects/${project.id}/agent/tasks`, { method: 'POST', headers, body: JSON.stringify({ modelConfigId: model.id, model: 'gpt-6-sol', reasoningEffort: 'high', prompt: 'make a local change', permissionProfile: 'workspace-write', approvalToken }) });
  assert.equal(started.status, 202);
  let task = await started.json();
  for (let attempt = 0; attempt < 400 && !['succeeded', 'failed'].includes(task.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    task = await (await fetch(`${api.origin}/api/local/agent/tasks/${task.id}`, { headers })).json();
  }
  assert.equal(task.status, 'succeeded');
  assert.equal(fs.readFileSync(path.join(workspace, 'agent-created.txt'), 'utf8'), 'local change\n');
  assert.ok(task.events.some((event) => event.text === 'done locally'));
  assert.ok(task.events.some((event) => event.kind === 'result'));
  assert.equal(task.selectedModel, 'gpt-6-sol'); assert.equal(task.reasoningEffort, 'high');
  assert.equal(task.inputTokens, 120); assert.equal(task.cachedInputTokens, 40); assert.equal(task.outputTokens, 30);
  const usage = await (await fetch(`${api.origin}/api/local/models/usage`, { headers })).json();
  assert.deepEqual(usage.items[0], { model: 'gpt-6-sol', tasks: 1, inputTokens: 120, cachedInputTokens: 40, outputTokens: 30, totalTokens: 150 });

  const replayed = await fetch(`${api.origin}/api/local/projects/${project.id}/agent/tasks`, { method: 'POST', headers, body: JSON.stringify({ modelConfigId: model.id, prompt: 'replay approval', permissionProfile: 'workspace-write', approvalToken }) });
  assert.equal(replayed.status, 403);
  const mismatchedApprovalToken = api.issueAgentWriteApproval({ projectId: project.id, modelConfigId: model.id, prompt: 'approved wording' });
  const mismatched = await fetch(`${api.origin}/api/local/projects/${project.id}/agent/tasks`, { method: 'POST', headers, body: JSON.stringify({ modelConfigId: model.id, prompt: 'different wording', permissionProfile: 'workspace-write', approvalToken: mismatchedApprovalToken }) });
  assert.equal(mismatched.status, 403);
  const slowApprovalToken = api.issueAgentWriteApproval({ projectId: project.id, modelConfigId: model.id, prompt: 'slow-task' });
  const slowResponse = await fetch(`${api.origin}/api/local/projects/${project.id}/agent/tasks`, { method: 'POST', headers, body: JSON.stringify({ modelConfigId: model.id, prompt: 'slow-task', permissionProfile: 'workspace-write', approvalToken: slowApprovalToken }) });
  assert.equal(slowResponse.status, 202);
  const slowTask = await slowResponse.json();
  const busyResponse = await fetch(`${api.origin}/api/local/projects/${project.id}/agent/tasks`, { method: 'POST', headers, body: JSON.stringify({ modelConfigId: model.id, prompt: 'another task', permissionProfile: 'read-only' }) });
  assert.equal(busyResponse.status, 409);
  const cancelResponse = await fetch(`${api.origin}/api/local/agent/tasks/${slowTask.id}/cancel`, { method: 'POST', headers });
  assert.equal(cancelResponse.status, 202);
  let cancelledTask = await cancelResponse.json();
  for (let attempt = 0; attempt < 200 && !['cancelled', 'failed'].includes(cancelledTask.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    cancelledTask = await (await fetch(`${api.origin}/api/local/agent/tasks/${slowTask.id}`, { headers })).json();
  }
  assert.equal(cancelledTask.status, 'cancelled');
});

test('OpenAI-compatible assistant can inspect project symbols through bounded code tools', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-agent-tools-')); const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'index.ts'), 'export const projectAnswer = 42;\n'); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0; const modelServer = http.createServer((request, response) => { const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => { calls += 1; const body = JSON.parse(Buffer.concat(chunks).toString()); response.writeHead(200, { 'Content-Type': 'application/json' }); if (calls === 1) { assert.ok(body.tools.some((item) => item.function.name === 'workspace_symbols')); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'workspace_symbols', arguments: '{"query":"projectAnswer"}' } }] } }] })); } else { const tool = body.messages.find((item) => item.role === 'tool'); assert.match(tool.content, /projectAnswer/); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已找到项目符号 projectAnswer。' } }] })); } }); });
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => modelServer.close(resolve)));
  const address = modelServer.address(); const api = await createLocalApi({ token: 'test-token', storePath: path.join(directory, 'local.sqlite3') }); t.after(() => api.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }; const project = api.registerWorkspace(workspace);
  const model = await (await fetch(`${api.origin}/api/local/models`, { method: 'POST', headers, body: JSON.stringify({ name: 'Compatible Model', engine: 'openai-compatible', provider: 'test', baseUrl: `http://127.0.0.1:${address.port}`, model: 'test-model' }) })).json();
  const started = await fetch(`${api.origin}/api/local/projects/${project.id}/agent/tasks`, { method: 'POST', headers, body: JSON.stringify({ modelConfigId: model.id, prompt: '项目答案在哪里？', permissionProfile: 'read-only' }) });
  let task = await started.json(); for (let attempt = 0; attempt < 400 && !['succeeded', 'failed'].includes(task.status); attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 25)); task = await (await fetch(`${api.origin}/api/local/agent/tasks/${task.id}`, { headers })).json(); }
  assert.equal(task.status, 'succeeded'); assert.equal(calls, 2); assert.ok(task.events.some((event) => event.kind === 'tool_use' && event.toolName === '搜索项目符号')); assert.ok(task.events.some((event) => /projectAnswer/.test(event.text || '')));
});

test('native directory selection registers a local-only workspace', async (t) => {
  const api = await createLocalApi({ token: 'test-token' });
  t.after(() => api.close());
  const project = api.registerWorkspace('/tmp/example-project');
  assert.equal(project.name, 'example-project');
  assert.equal(project.path, path.resolve('/tmp/example-project'));
  const response = await fetch(`${api.origin}/api/local/projects`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.deepEqual((await response.json()).items, [project]);
});

test('registered workspace supports scoped tree, read and atomic save', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-workspace-'));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'node_modules'));
  fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(workspace, 'node_modules', 'ignored.js'), 'ignored');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const api = await createLocalApi({ token: 'test-token' });
  t.after(() => api.close());
  const project = api.registerWorkspace(workspace);
  const headers = { Authorization: 'Bearer test-token' };

  const tree = await fetch(`${api.origin}/api/local/projects/${project.id}/files`, { headers });
  const entries = (await tree.json()).items;
  assert.deepEqual(entries.map((entry) => entry.path), ['src', 'src/index.ts']);

  const contentUrl = `${api.origin}/api/local/projects/${project.id}/content`;
  const read = await fetch(`${contentUrl}?path=${encodeURIComponent('src/index.ts')}`, { headers });
  const initialFile = await read.json();
  assert.equal(initialFile.content, 'export const value = 1;\n');

  const search = await fetch(`${api.origin}/api/local/projects/${project.id}/search?query=${encodeURIComponent('value = 1')}`, { headers });
  assert.equal(search.status, 200);
  const searchBody = await search.json();
  assert.equal(searchBody.engine, 'ripgrep');
  assert.deepEqual(searchBody.items[0], { path: 'src/index.ts', line: 1, column: 14, preview: 'export const value = 1;' });

  const sourceIndex = await fetch(`${api.origin}/api/local/projects/${project.id}/index`, { headers });
  const sourceIndexBody = await sourceIndex.json();
  assert.deepEqual(sourceIndexBody.files, [{ path: 'src/index.ts', content: 'export const value = 1;\n' }]);
  assert.deepEqual(sourceIndexBody.limits, { files: 500, totalBytes: 8388608, fileBytes: 262144 });
  assert.equal(sourceIndexBody.truncated, false);

  const activity = await fetch(`${api.origin}/api/local/projects/${project.id}/activity`, { headers });
  assert.equal(activity.status, 200);
  assert.deepEqual(await activity.json(), { preview: { targets: [], scripts: [], status: 'stopped', url: null, port: null, targetId: null, targetLabel: null, script: null, logs: [] }, terminal: null, agentTasks: [] });

  const symbols = await fetch(`${api.origin}/api/local/projects/${project.id}/symbols?query=val`, { headers });
  assert.deepEqual((await symbols.json()).items, [{ name: 'value', kind: 'const', path: 'src/index.ts', line: 1, column: 14 }]);

  const createdFolder = await fetch(`${api.origin}/api/local/projects/${project.id}/files`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'src/generated', type: 'directory' }) });
  assert.equal(createdFolder.status, 201); assert.equal(fs.statSync(path.join(workspace, 'src', 'generated')).isDirectory(), true);
  const createdFile = await fetch(`${api.origin}/api/local/projects/${project.id}/files`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'src/generated/NewFile.ts', type: 'file' }) });
  assert.equal(createdFile.status, 201); assert.equal(fs.readFileSync(path.join(workspace, 'src', 'generated', 'NewFile.ts'), 'utf8'), '');
  const duplicate = await fetch(`${api.origin}/api/local/projects/${project.id}/files`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'src/generated/NewFile.ts', type: 'file' }) });
  assert.equal(duplicate.status, 409);
  const deletedFile = await fetch(`${api.origin}/api/local/projects/${project.id}/files?path=${encodeURIComponent('src/generated/NewFile.ts')}`, { method: 'DELETE', headers });
  assert.equal(deletedFile.status, 204); assert.equal(fs.existsSync(path.join(workspace, 'src', 'generated', 'NewFile.ts')), false);
  const deletedFolder = await fetch(`${api.origin}/api/local/projects/${project.id}/files?path=${encodeURIComponent('src/generated')}`, { method: 'DELETE', headers });
  assert.equal(deletedFolder.status, 204); assert.equal(fs.existsSync(path.join(workspace, 'src', 'generated')), false);
  const escapedCreate = await fetch(`${api.origin}/api/local/projects/${project.id}/files`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '../outside.txt', type: 'file' }) });
  assert.equal(escapedCreate.status, 400);

  const save = await fetch(contentUrl, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'src/index.ts', content: 'export const value = 2;\n', expectedVersion: initialFile.version }),
  });
  assert.equal(save.status, 200);
  assert.equal(fs.readFileSync(path.join(workspace, 'src', 'index.ts'), 'utf8'), 'export const value = 2;\n');

  const conflict = await fetch(contentUrl, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'src/index.ts', content: 'stale write', expectedVersion: initialFile.version }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'LOCAL_FILE_CONFLICT');

  const escaped = await fetch(`${contentUrl}?path=${encodeURIComponent('../outside.txt')}`, { headers });
  assert.notEqual(escaped.status, 200);
});

test('large workspace source index reports deterministic resource limits and truncation', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-large-index-'));
  for (let index = 0; index < 505; index += 1) fs.writeFileSync(path.join(workspace, `file-${String(index).padStart(3, '0')}.ts`), `export const value${index} = ${index};\n`);
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const api = await createLocalApi({ token: 'test-token' }); t.after(() => api.close());
  const project = api.registerWorkspace(workspace);
  const response = await fetch(`${api.origin}/api/local/projects/${project.id}/index`, { headers: { Authorization: 'Bearer test-token' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.files.length, 500);
  assert.equal(body.truncated, true);
  assert.deepEqual(body.limits, { files: 500, totalBytes: 8388608, fileBytes: 262144 });
});

test('workspace automatically previews images, PDF metadata and Excel workbooks without decoding them as text', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-file-preview-'));
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(workspace, 'pixel.png'), imageBytes);
  fs.writeFileSync(path.join(workspace, 'manual.pdf'), '%PDF-1.4\n');
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('数据');
  sheet.addRow(['名称', '数量']); sheet.addRow(['苹果', 3]);
  await workbook.xlsx.writeFile(path.join(workspace, 'report.xlsx'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const api = await createLocalApi({ token: 'test-token' }); t.after(() => api.close());
  const project = api.registerWorkspace(workspace); const headers = { Authorization: 'Bearer test-token' };
  const contentUrl = `${api.origin}/api/local/projects/${project.id}/content`;

  const imageMetadata = await (await fetch(`${contentUrl}?path=pixel.png`, { headers })).json();
  assert.equal(imageMetadata.kind, 'image'); assert.equal(imageMetadata.mime, 'image/png');
  assert.equal(Object.hasOwn(imageMetadata, 'content'), false);
  const rawImage = await fetch(`${api.origin}/api/local/projects/${project.id}/file-preview?path=pixel.png`, { headers });
  assert.equal(rawImage.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await rawImage.arrayBuffer()), imageBytes);

  const pdfMetadata = await (await fetch(`${contentUrl}?path=manual.pdf`, { headers })).json();
  assert.equal(pdfMetadata.kind, 'pdf');
  const spreadsheet = await (await fetch(`${api.origin}/api/local/projects/${project.id}/spreadsheet?path=report.xlsx`, { headers })).json();
  assert.equal(spreadsheet.sheets[0].name, '数据');
  assert.deepEqual(spreadsheet.sheets[0].rows.slice(0, 2), [['名称', '数量'], ['苹果', '3']]);
});

test('workspace scan skips unreadable directories instead of failing the project', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-permissions-'));
  const unreadable = path.join(workspace, 'private-cache');
  fs.mkdirSync(unreadable);
  fs.writeFileSync(path.join(unreadable, 'secret.ts'), 'export const secret = true;\n');
  fs.writeFileSync(path.join(workspace, 'visible.ts'), 'export const visible = true;\n');
  fs.chmodSync(unreadable, 0o000);
  t.after(() => {
    try { fs.chmodSync(unreadable, 0o700); } catch {}
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const api = await createLocalApi({ token: 'test-token' });
  t.after(() => api.close());
  const project = api.registerWorkspace(workspace);
  const response = await fetch(`${api.origin}/api/local/projects/${project.id}/files`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(response.status, 200);
  const paths = (await response.json()).items.map((entry) => entry.path);
  assert.ok(paths.includes('visible.ts'));
});

test('local Git status, diff and selected-file commit stay inside the workspace', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-git-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-remote-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(remote, { recursive: true, force: true }); });
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
  execFileSync('git', ['init', '--bare', '-q', remote]);
  git('init', '-q');
  git('config', 'user.name', 'Code Studio Test');
  git('config', 'user.email', 'code-studio@example.test');
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'before\n');
  git('add', 'tracked.txt'); git('commit', '-q', '-m', 'initial');
  git('remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'after\n');

  const api = await createLocalApi({ token: 'test-token' });
  t.after(() => api.close());
  const project = api.registerWorkspace(workspace);
  const headers = { Authorization: 'Bearer test-token' };
  const base = `${api.origin}/api/local/projects/${project.id}/git`;

  const statusResponse = await fetch(`${base}/status`, { headers });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.repository, true);
  assert.deepEqual(status.files, [{ path: 'tracked.txt', indexStatus: ' ', worktreeStatus: 'M' }]);

  const diffResponse = await fetch(`${base}/diff?path=tracked.txt`, { headers });
  assert.match((await diffResponse.json()).working, /\+after/);
  const escapeResponse = await fetch(`${base}/diff?path=${encodeURIComponent('../outside.txt')}`, { headers });
  assert.equal(escapeResponse.status, 400);

  const commitResponse = await fetch(`${base}/commit`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'update tracked file', paths: ['tracked.txt'] }),
  });
  assert.equal(commitResponse.status, 200);
  assert.equal((await commitResponse.json()).status.files.length, 0);
  assert.equal(git('log', '-1', '--pretty=%s').trim(), 'update tracked file');

  const branchesResponse = await fetch(`${base}/branches`, { headers });
  assert.deepEqual((await branchesResponse.json()).remotes, ['origin']);
  const checkoutResponse = await fetch(`${base}/checkout`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: 'feature/local-runtime', create: true }),
  });
  assert.equal(checkoutResponse.status, 200);
  assert.equal((await checkoutResponse.json()).status.branch, 'feature/local-runtime');

  const pushResponse = await fetch(`${base}/sync`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'push', remote: 'origin' }),
  });
  assert.equal(pushResponse.status, 200);
  assert.match(execFileSync('git', ['--git-dir', remote, 'branch', '--list', 'feature/local-runtime'], { encoding: 'utf8' }), /feature\/local-runtime/);
});
