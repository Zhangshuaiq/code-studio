const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { resolveGitRemote, checkGitRemotePolicy, gitRemoteHost } = require('../src/local-git-policy.cjs');
const { createLocalApi } = require('../src/local-api.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-git-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-b', 'main');
  const run = async (_root, args, options = {}) => {
    try { return { code: 0, stdout: git(...args), stderr: '' }; }
    catch (error) { if (!options.allowFailure) throw error; return { code: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }; }
  };
  return { root, git, run };
}
const status = { enforcementRequired: true, policy: { allowedGitHosts: ['github.com', 'local'] } };

test('push policy checks all push URLs and Git URL rewrites instead of the fetch URL', async t => {
  const { root, git, run } = fixture(t);
  git('remote', 'add', 'origin', 'https://github.com/team/repo.git');
  git('remote', 'set-url', '--push', 'origin', 'ssh://forbidden.example/team/repo.git');
  assert.equal((await checkGitRemotePolicy(root, status, 'fetch', 'origin', run)).allowed, true);
  assert.deepEqual(await checkGitRemotePolicy(root, status, 'push', 'origin', run), { allowed: false, host: 'forbidden.example' });
  git('remote', 'set-url', '--push', 'origin', 'https://github.com/team/repo.git');
  git('remote', 'set-url', '--add', '--push', 'origin', 'git@second.example:team/repo.git');
  assert.equal((await checkGitRemotePolicy(root, status, 'push', 'origin', run)).host, 'second.example');
  git('config', '--unset-all', 'remote.origin.pushurl');
  git('config', 'url.ssh://rewrite.example/.pushInsteadOf', 'https://github.com/');
  assert.equal((await checkGitRemotePolicy(root, status, 'fetch', 'origin', run)).allowed, true);
  assert.equal((await checkGitRemotePolicy(root, status, 'push', 'origin', run)).host, 'rewrite.example');
});

test('default remote honors branch pushRemote before pushDefault and branch remote', async t => {
  const { root, git, run } = fixture(t);
  assert.equal(await resolveGitRemote(root, 'push', null, 'main', run), 'origin');
  git('config', 'branch.main.remote', 'upstream');
  assert.equal(await resolveGitRemote(root, 'pull', null, 'main', run), 'upstream');
  assert.equal(await resolveGitRemote(root, 'push', null, 'main', run), 'upstream');
  git('config', 'remote.pushDefault', 'publish');
  assert.equal(await resolveGitRemote(root, 'push', null, 'main', run), 'publish');
  git('config', 'branch.main.pushRemote', 'personal');
  assert.equal(await resolveGitRemote(root, 'push', null, 'main', run), 'personal');
  assert.equal(await resolveGitRemote(root, 'push', 'selected', 'main', run), 'selected');
  assert.equal(await resolveGitRemote(root, 'fetch', null, 'main', run), null);
});

test('managed policies fail closed for unresolved remotes/helpers and inspect fetch-all', async t => {
  const { root, git, run } = fixture(t);
  assert.equal((await checkGitRemotePolicy(root, status, 'push', 'missing', run)).allowed, false);
  git('remote', 'add', 'origin', 'https://github.com/team/repo.git');
  git('remote', 'add', 'other', 'git@forbidden.example:team/repo.git');
  assert.equal((await checkGitRemotePolicy(root, status, 'fetch', null, run)).host, 'forbidden.example');
  assert.equal((await checkGitRemotePolicy(root, status, 'pull', '.', run)).allowed, true);
  assert.equal((await checkGitRemotePolicy(root, { enforcementRequired: true, policy: { allowedGitHosts: [] } }, 'pull', '.', run)).allowed, false);
  assert.equal(gitRemoteHost('ext::some-program'), null);
  assert.equal(gitRemoteHost('custom://github.com/repo'), null);
  assert.equal((await checkGitRemotePolicy(root, { enforcementRequired: false }, 'push', 'missing', run)).allowed, true);
});

test('Local API rejects forbidden push URLs/default remotes before executing a push', async t => {
  const { root, git } = fixture(t);
  const keys = crypto.generateKeyPairSync('ed25519'); const now = Math.floor(Date.now() / 1000);
  const api = await createLocalApi({ token: 'fixture-token', storePath: path.join(root, 'store.sqlite3'), policyPublicKey: keys.publicKey, policyNow: now * 1000, appVersion: '0.1.0' });
  t.after(() => api.close());
  const project = api.registerWorkspace(root);
  const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' };
  const post = (route, body) => fetch(`${api.origin}/api/local/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ organizationId: 'org-git', issuedAt: now - 60, expiresAt: now + 60, offlineUntil: now + 120, policy: { terminalEnabled: true, allowedModelEngines: [], allowedConnectorTypes: [], allowedGitHosts: ['github.com'], allowedNetworkHosts: [], minimumClientVersion: '0.1.0' } })).toString('base64url');
  const token = `${header}.${claims}.${crypto.sign(null, Buffer.from(`${header}.${claims}`), keys.privateKey).toString('base64url')}`;
  assert.equal((await post('enterprise/policy', { token })).status, 200);
  git('remote', 'add', 'origin', 'https://github.com/team/repo.git');
  git('remote', 'set-url', '--push', 'origin', 'ssh://forbidden.example/team/repo.git');
  const explicit = await post(`projects/${project.id}/git/sync`, { operation: 'push', remote: 'origin' });
  assert.equal(explicit.status, 403); assert.match((await explicit.json()).message, /forbidden.example/);
  git('remote', 'add', 'publish', 'ssh://default-forbidden.example/team/repo.git');
  git('config', 'branch.main.pushRemote', 'publish');
  const implicit = await post(`projects/${project.id}/git/sync`, { operation: 'push' });
  assert.equal(implicit.status, 403); assert.match((await implicit.json()).message, /default-forbidden.example/);
  assert.equal((await post(`projects/${project.id}/git/sync`, { operation: 'push', remote: 'unknown' })).status, 403);
});

test('explicit remote selection pushes to that repository despite branch pushRemote', async t => {
  const { root, git } = fixture(t);
  const origin = path.join(root, 'origin.git'); const publish = path.join(root, 'publish.git');
  git('init', '--bare', origin); git('init', '--bare', publish);
  fs.writeFileSync(path.join(root, 'source.txt'), 'fixture\n');
  git('add', 'source.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
  git('remote', 'add', 'origin', origin); git('remote', 'add', 'publish', publish);
  git('push', '--set-upstream', 'origin', 'main');
  git('config', 'branch.main.pushRemote', 'publish');
  fs.writeFileSync(path.join(root, 'source.txt'), 'second\n');
  git('add', 'source.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'second');
  const api = await createLocalApi({ token: 'fixture-token', storePath: path.join(root, 'store.sqlite3') }); t.after(() => api.close());
  const project = api.registerWorkspace(root);
  const response = await fetch(`${api.origin}/api/local/projects/${project.id}/git/sync`, { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'push', remote: 'origin' }) });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(git('--git-dir', origin, 'rev-parse', 'refs/heads/main').trim(), git('rev-parse', 'HEAD').trim());
  assert.equal(git('--git-dir', publish, 'for-each-ref', '--format=%(refname)'), '', 'unselected repository must remain untouched');
});
