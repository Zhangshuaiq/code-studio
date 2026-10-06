const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { evaluateLicense } = require('../src/license-verifier.cjs');

const keys = crypto.generateKeyPairSync('ed25519');
const now = Date.UTC(2026, 8, 24, 12) / 1000;
function token(overrides = {}, signingKey = keys.privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'user-1', deviceId: 'device-1', edition: 'personal-pro', iat: now - 60, exp: now + 3600, graceUntil: now + 7200, entitlements: ['cloud.sync'], ...overrides })).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(`${header}.${payload}`), signingKey).toString('base64url'); return `${header}.${payload}.${signature}`;
}

test('verified license transitions through active, grace and community degradation', () => {
  const value = token();
  assert.equal(evaluateLicense(value, { publicKey: keys.publicKey, deviceId: 'device-1', now: now * 1000 }).state, 'active');
  const grace = evaluateLicense(value, { publicKey: keys.publicKey, deviceId: 'device-1', now: (now + 4000) * 1000 }); assert.equal(grace.state, 'grace'); assert.deepEqual(grace.entitlements, ['cloud.sync']);
  const expired = evaluateLicense(value, { publicKey: keys.publicKey, deviceId: 'device-1', now: (now + 8000) * 1000 }); assert.equal(expired.state, 'expired'); assert.equal(expired.edition, 'community'); assert.deepEqual(expired.entitlements, []); assert.equal(expired.coreCapabilitiesEnabled, true);
});

test('invalid signature and device mismatch never disable community core capabilities', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  for (const status of [evaluateLicense(token({}, other.privateKey), { publicKey: keys.publicKey, deviceId: 'device-1', now: now * 1000 }), evaluateLicense(token(), { publicKey: keys.publicKey, deviceId: 'other-device', now: now * 1000 })]) { assert.equal(status.state, 'invalid'); assert.equal(status.edition, 'community'); assert.equal(status.coreCapabilitiesEnabled, true); assert.deepEqual(status.entitlements, []); }
});
