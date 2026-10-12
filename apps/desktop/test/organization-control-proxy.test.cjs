const test = require('node:test'); const assert = require('node:assert/strict');
const http = require('node:http'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { organizationRequest } = require('../src/organization-control-proxy.cjs');
const { createLocalApi } = require('../src/local-api.cjs');
const prefix = '/api/local/account/enterprise';
test('organization proxy accepts only scoped routes, bounded fields and audit query keys', () => {
  const url = (suffix) => new URL(`http://localhost${prefix}${suffix}`);
  const policy = { terminalEnabled: false, allowedModelEngines: ['codex-cli'], allowedConnectorTypes: [], allowedGitHosts: ['local'], allowedNetworkHosts: [], minimumClientVersion: '0.1.0', offlineDays: 7, expectedUpdatedAt: new Date().toISOString() };
  assert.equal(organizationRequest('GET', url('/organizations/org/policy')).pathname, '/api/control/enterprise/organizations/org/policy');
  assert.deepEqual(organizationRequest('PUT', url('/organizations/org/policy'), policy).body, policy);
  for (const invalid of [{ ...policy, expectedUpdatedAt: undefined }, { ...policy, offlineDays: 91 }, { ...policy, allowedModelEngines: 'codex-cli' }, { ...policy, organizationId: 'foreign' }, { ...policy, allowedNetworkHosts: Array(201).fill('company.com') }]) assert.throws(() => organizationRequest('PUT', url('/organizations/org/policy'), invalid));
  for (const [method, suffix, body] of [
    ['GET', '/organizations'], ['GET', '/organizations/org/members'], ['GET', '/organizations/org/invitations'], ['GET', '/organizations/org/domains'], ['GET', '/organizations/org/audit?q=A%26B&page=2'],
    ['PUT', '/organizations/org/members/user/role', { role: 'admin' }], ['DELETE', '/organizations/org/members/user'],
    ['PUT', '/organizations/org/members/user/role', { role: 'auditor' }],
    ['POST', '/organizations/org/invitations', { email: 'staff@example.com', role: 'member' }], ['DELETE', '/organizations/org/invitations/invite'],
    ['POST', '/organizations/org/invitations', { email: 'audit@example.com', role: 'auditor' }],
    ['POST', '/organizations/org/domains', { domain: 'company.com' }], ['POST', '/organizations/org/domains/domain/verify'], ['DELETE', '/organizations/org/domains/domain'],
  ]) assert.ok(organizationRequest(method, url(suffix), body).pathname.startsWith('/api/control/enterprise/organizations'));
  for (const [method, suffix, body] of [
    ['GET', '/organizations/org/policy/export'], ['POST', '/organizations'], ['GET', '/organizations/org/domains?url=http://foreign'],
    ['GET', '/organizations/org/audit?resourceId=foreign'], ['GET', '/organizations/org/audit?q=x&q=y'], ['GET', '/organizations/org/audit?q=' + 'a'.repeat(201)],
    ['POST', '/organizations/org/domains', { domain: 'company.com', organizationId: 'foreign' }], ['PUT', '/organizations/org/members/user/role', { role: 'platform-admin' }],
    ['POST', '/organizations/org/invitations', { email: 'staff@example.com', role: 'owner' }], ['POST', '/organizations/org/domains/domain/verify', { url: 'http://foreign' }],
    ['GET', '/organizations/org%2Fforeign/members'], ['POST', '/organizations/org/domains', []],
  ]) assert.throws(() => organizationRequest(method, url(suffix), body));
});

test('desktop organization requests keep bearer private, bind server/session, and drop stale responses', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'organization-proxy-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = []; let lateResponse; let lateStarted;
  const control = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}; response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/auth/login') return response.end(JSON.stringify({ accessToken: `remote-secret-${body.username}`, user: { id: body.username, username: body.username } }));
    calls.push({ path: request.url, method: request.method, body, authorization: request.headers.authorization });
    if (request.url.endsWith('/audit?q=forbidden')) { response.writeHead(403); return response.end(JSON.stringify({ message: 'remote-secret-Owner' })); }
    if (request.url.endsWith('/audit?q=expired')) { response.writeHead(401); return response.end('{}'); }
    if (/\/audit\?q=late(?:-expired)?$/.test(request.url)) { lateResponse = response; lateStarted?.(); return; }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => control.close(resolve)));
  const codec = { available: () => true, encrypt: (value) => Buffer.from(`safe:${value}`).toString('base64'), decrypt: (value) => Buffer.from(value, 'base64').toString().slice(5) };
  const origin = `http://127.0.0.1:${control.address().port}`; let serverUrl = origin;
  const api = await createLocalApi({ token: 'local-token', storePath: path.join(directory, 'local.sqlite3'), credentialCodec: codec, controlServerUrl: () => serverUrl }); t.after(() => api.close());
  const headers = { Authorization: 'Bearer local-token', 'Content-Type': 'application/json' };
  const account = async () => (await fetch(`${api.origin}/api/local/account`, { headers })).json();
  const login = async (username) => { assert.equal((await fetch(`${api.origin}/api/local/account/login`, { method: 'POST', headers, body: JSON.stringify({ username, password: 'password' }) })).status, 200); return account(); };
  const endpoint = `${api.origin}${prefix}/organizations/org`;
  assert.equal((await fetch(endpoint + '/members', { headers })).status, 401); assert.equal(calls.length, 0);
  let state = await login('Owner'); const sessionHeaders = { ...headers, 'X-Code-Studio-Control-Session': state.controlSessionId };
  assert.ok(state.controlSessionId); assert.ok(!JSON.stringify(state).includes('remote-secret'));
  assert.equal((await fetch(endpoint + '/members', { headers })).status, 409); assert.equal(calls.length, 0);
  for (const [suffix, method, body] of [['/members', 'GET'], ['/invitations', 'POST', { email: 'staff@example.com', role: 'member' }], ['/members/user/role', 'PUT', { role: 'admin' }], ['/domains', 'POST', { domain: 'company.com' }], ['/domains/domain/verify', 'POST'], ['/domains/domain', 'DELETE'], ['/audit?q=A%26B&page=2', 'GET']]) {
    const response = await fetch(endpoint + suffix, { method, headers: sessionHeaders, ...(body ? { body: JSON.stringify(body) } : {}) }); assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(await response.json()).includes('remote-secret'));
    assert.equal(calls.at(-1).authorization, 'Bearer remote-secret-Owner');
    assert.equal(calls.at(-1).path, '/api/control/enterprise/organizations/org' + suffix);
  }
  const before = calls.length;
  assert.equal((await fetch(endpoint + '/audit?resourceId=foreign', { headers: sessionHeaders })).status, 400);
  assert.equal((await fetch(endpoint + '/policy/export', { headers: sessionHeaders })).status, 404); assert.equal(calls.length, before);
  const denied = await fetch(endpoint + '/audit?q=forbidden', { headers: sessionHeaders }); assert.equal(denied.status, 403); assert.ok(!(await denied.text()).includes('remote-secret'));
  serverUrl = 'http://127.0.0.1:1';
  state = await account(); assert.equal(state.signedIn, false); assert.equal(state.user, null);
  const prior = calls.length; assert.equal((await fetch(endpoint + '/members', { headers: sessionHeaders })).status, 401); assert.equal(calls.length, prior);
  serverUrl = origin;
  const started = new Promise((resolve) => { lateStarted = resolve; });
  const late = fetch(endpoint + '/audit?q=late', { headers: sessionHeaders }); await started;
  state = await login('Second'); assert.notEqual(state.controlSessionId, sessionHeaders['X-Code-Studio-Control-Session']);
  lateResponse.end(JSON.stringify({ actorName: 'PreviousAccountPrivateData' }));
  const stale = await late; assert.equal(stale.status, 409); assert.ok(!(await stale.text()).includes('PreviousAccountPrivateData'));
  assert.equal((await fetch(endpoint + '/members', { headers: sessionHeaders })).status, 409);
  // Even if the same account receives the same bearer again, an old 401 must
  // not delete the credentials of its newly established desktop session.
  const secondHeaders = { ...headers, 'X-Code-Studio-Control-Session': state.controlSessionId };
  const expiredStarted = new Promise((resolve) => { lateStarted = resolve; });
  const lateExpired = fetch(endpoint + '/audit?q=late-expired', { headers: secondHeaders }); await expiredStarted;
  state = await login('Second'); lateResponse.writeHead(401); lateResponse.end('{}');
  assert.equal((await lateExpired).status, 409); assert.equal((await account()).signedIn, true);
  const newHeaders = { ...headers, 'X-Code-Studio-Control-Session': state.controlSessionId };
  assert.equal((await fetch(endpoint + '/audit?q=expired', { headers: newHeaders })).status, 401); assert.equal((await account()).signedIn, false);
  assert.equal((await fetch(`${api.origin}/api/local/capabilities`, { headers })).status, 200);
  assert.ok(!fs.readFileSync(path.join(directory, 'local.sqlite3')).includes(Buffer.from('remote-secret')));
});
