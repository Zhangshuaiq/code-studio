const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { signLicenseToken } = require('../dist/license/license-token.js');
const { evaluateLicense } = require('../../desktop/src/license-verifier.cjs');

test('Control API license tokens are accepted by the desktop verifier and remain device-bound', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: 'user-1', deviceId: 'device-1', edition: 'personal-pro', iat: now, exp: now + 3600, graceUntil: now + 7200, entitlements: ['cloud.sync'] };
  const token = signLicenseToken(claims, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), 'test-key');
  const status = evaluateLicense(token, { publicKey, deviceId: 'device-1', now: now * 1000 });
  assert.equal(status.state, 'active'); assert.equal(status.edition, 'personal-pro'); assert.deepEqual(status.entitlements, ['cloud.sync']);
  const wrongDevice = evaluateLicense(token, { publicKey, deviceId: 'device-2', now: now * 1000 });
  assert.equal(wrongDevice.state, 'invalid'); assert.match(wrongDevice.error, /不属于当前设备/);
});

test('license signing rejects non-Ed25519 keys', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signLicenseToken({ sub: 'u', deviceId: 'd', edition: 'personal-pro', iat: 1, exp: 2, graceUntil: 3, entitlements: [] }, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()), /Ed25519/);
});
