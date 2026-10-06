const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { evaluatePolicy } = require('../src/policy-verifier.cjs');

const keys = crypto.generateKeyPairSync('ed25519');
const now = Math.floor(Date.now() / 1000);
function token(overrides = {}, key = keys.privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ organizationId: 'org-1', issuedAt: now - 60, expiresAt: now + 60, offlineUntil: now + 3600, policy: { terminalEnabled: false, allowedModelEngines: ['codex-cli'], allowedConnectorTypes: ['postgres'], allowedGitHosts: ['github.com'], allowedNetworkHosts: ['api.example.com'], minimumClientVersion: '0.1.0' }, ...overrides })).toString('base64url');
  return `${header}.${payload}.${crypto.sign(null, Buffer.from(`${header}.${payload}`), key).toString('base64url')}`;
}

test('signed enterprise policy remains enforced through active, grace and expiry states', () => {
  const value = token();
  for (const [offset, state] of [[0, 'active'], [120, 'grace'], [4000, 'expired']]) {
    const result = evaluatePolicy(value, { publicKey: keys.publicKey, now: (now + offset) * 1000 });
    assert.equal(result.state, state); assert.equal(result.enforcementRequired, true); assert.equal(result.policy.terminalEnabled, false);
    assert.deepEqual(result.policy.allowedModelEngines, state === 'expired' ? [] : ['codex-cli']); assert.deepEqual(result.policy.allowedGitHosts, state === 'expired' ? [] : ['github.com']);
  }
});

test('tampered enterprise policy fails closed while unmanaged devices remain unrestricted', () => {
  assert.equal(evaluatePolicy(null).state, 'unmanaged');
  const other = crypto.generateKeyPairSync('ed25519'); const result = evaluatePolicy(token({}, other.privateKey), { publicKey: keys.publicKey, now: now * 1000 });
  assert.equal(result.state, 'invalid'); assert.equal(result.enforcementRequired, true); assert.equal(result.policy.terminalEnabled, false); assert.deepEqual(result.policy.allowedModelEngines, []);
});

test('enterprise policy requires the configured minimum desktop version', () => {
  const value = token({ policy: { terminalEnabled: true, allowedModelEngines: ['codex-cli'], allowedConnectorTypes: ['postgres'], allowedGitHosts: ['local'], allowedNetworkHosts: [], minimumClientVersion: '2.4.0' } });
  const outdated = evaluatePolicy(value, { publicKey: keys.publicKey, now: now * 1000, appVersion: '2.3.9' });
  assert.equal(outdated.state, 'upgrade-required'); assert.equal(outdated.minimumClientVersion, '2.4.0'); assert.equal(outdated.policy.terminalEnabled, false);
  assert.equal(evaluatePolicy(value, { publicKey: keys.publicKey, now: now * 1000, appVersion: '2.4.0' }).state, 'active');
});
