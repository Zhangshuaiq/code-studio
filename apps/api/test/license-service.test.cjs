const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { LicenseService } = require('../dist/license/license.service.js');
const { evaluateLicense } = require('../../desktop/src/license-verifier.cjs');

function fixture(maxDevices = 1) {
  const devices = [];
  const subscription = { userId: 'user-1', edition: 'personal-pro', status: 'active', expiresAt: new Date(Date.now() + 3600_000), graceDays: 7, maxDevices };
  const tx = {
    $queryRaw: async () => [{ locked: 1 }],
    licenseDevice: {
      findUnique: async ({ where }) => devices.find((item) => item.userId === where.userId_deviceId.userId && item.deviceId === where.userId_deviceId.deviceId) || null,
      count: async ({ where }) => devices.filter((item) => item.userId === where.userId && item.revokedAt === null).length,
      upsert: async ({ where, create, update }) => {
        let item = devices.find((entry) => entry.userId === where.userId_deviceId.userId && entry.deviceId === where.userId_deviceId.deviceId);
        if (item) Object.assign(item, update); else { item = { id: `record-${devices.length + 1}`, revokedAt: null, ...create }; devices.push(item); }
        return item;
      },
    },
  };
  const prisma = {
    licenseSubscription: { findUnique: async () => subscription },
    licenseDevice: {
      findMany: async () => devices,
      findFirst: async ({ where }) => devices.find((item) => item.id === where.id && item.userId === where.userId) || null,
      update: async ({ where, data }) => Object.assign(devices.find((item) => item.id === where.id), data),
    },
    $transaction: async (callback) => callback(tx),
  };
  const keys = crypto.generateKeyPairSync('ed25519');
  const pem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const config = { get: (key, fallback) => key === 'LICENSE_ED25519_PRIVATE_KEY' ? pem : key === 'LICENSE_KEY_ID' ? 'test' : fallback };
  return { service: new LicenseService(prisma, config), devices, publicKey: keys.publicKey };
}

test('license activation signs a desktop-compatible token and enforces the device limit', async () => {
  const { service, publicKey } = fixture(1);
  const first = await service.activate('user-1', { deviceId: 'device-000000001', name: 'Mac' });
  const verified = evaluateLicense(first.token, { publicKey, deviceId: 'device-000000001' });
  assert.equal(verified.state, 'active'); assert.deepEqual(verified.entitlements, ['cloud.sync']);
  await assert.rejects(service.activate('user-1', { deviceId: 'device-000000002', name: 'Windows' }), (error) => error?.response?.code === 'LICENSE_DEVICE_LIMIT');
});

test('users can revoke their own device and then activate a replacement', async () => {
  const { service, devices } = fixture(1);
  await service.activate('user-1', { deviceId: 'device-000000001' });
  assert.deepEqual(await service.revoke('user-1', devices[0].id), { success: true });
  assert.ok(devices[0].revokedAt instanceof Date);
  const replacement = await service.activate('user-1', { deviceId: 'device-000000002' });
  assert.equal(replacement.deviceId, 'device-000000002');
});

test('admin signs a device-bound offline response for a fresh challenge', async () => {
  const { service, publicKey } = fixture(1);
  const challenge = {
    format: 'code-studio-license-request-v1',
    deviceId: 'offline-device-00000001',
    nonce: crypto.randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
    platform: 'darwin',
  };
  const response = await service.issueOffline('user-1', challenge);
  assert.equal(response.format, 'code-studio-license-v1');
  assert.equal(response.challengeNonce, challenge.nonce);
  const verified = evaluateLicense(response.token, { publicKey, deviceId: challenge.deviceId });
  assert.equal(verified.state, 'active');
  assert.equal(verified.challengeNonce, challenge.nonce);
  assert.equal(verified.edition, 'personal-pro');
});

test('offline signing rejects malformed and expired challenges', async () => {
  const { service } = fixture(1);
  await assert.rejects(service.issueOffline('user-1', { format: 'invalid' }), (error) => error?.response?.code === 'LICENSE_CHALLENGE_INVALID');
  await assert.rejects(service.issueOffline('user-1', {
    format: 'code-studio-license-request-v1', deviceId: 'offline-device-00000001', nonce: crypto.randomBytes(32).toString('base64url'), createdAt: new Date(Date.now() - 31 * 86400_000).toISOString(),
  }), (error) => error?.response?.code === 'LICENSE_CHALLENGE_EXPIRED');
});

test('redeem codes are stored as hashes, extend a subscription once per user and enforce capacity', async () => {
  let codeRecord; let subscription; const redemptions = [];
  const licenseRedeemCode = {
    create: async ({ data }) => { codeRecord = { id: 'code-1', redemptionCount: 0, disabledAt: null, createdAt: new Date(), ...data }; return codeRecord; },
    findUnique: async ({ where }) => where.codeHash ? (where.codeHash === codeRecord?.codeHash ? codeRecord : null) : (where.id === codeRecord?.id ? codeRecord : null),
    update: async ({ data }) => { if (data.redemptionCount?.increment) codeRecord.redemptionCount += data.redemptionCount.increment; else Object.assign(codeRecord, data); return codeRecord; },
    findMany: async () => codeRecord ? [codeRecord] : [],
  };
  const tx = {
    $queryRaw: async () => [{ locked: 1 }], licenseRedeemCode,
    licenseRedemption: {
      findUnique: async ({ where }) => redemptions.find((item) => item.codeId === where.codeId_userId.codeId && item.userId === where.codeId_userId.userId) || null,
      create: async ({ data }) => { redemptions.push(data); return data; },
    },
    licenseSubscription: {
      findUnique: async () => subscription || null,
      upsert: async ({ create, update }) => { subscription = subscription ? { ...subscription, ...update } : { id: 'subscription-1', ...create }; return subscription; },
    },
  };
  const prisma = { licenseRedeemCode, $transaction: async (callback) => callback(tx) };
  const service = new LicenseService(prisma, { get: (_key, fallback) => fallback });
  const issued = await service.createRedeemCode({ edition: 'personal-pro', durationDays: 30, maxRedemptions: 1 });
  assert.match(issued.code, /^CS-(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/); assert.equal(Object.hasOwn(issued, 'codeHash'), false);
  assert.equal(JSON.stringify(codeRecord).includes(issued.code), false); assert.equal(codeRecord.codeHash.length, 64);
  const redeemed = await service.redeem('user-1', issued.code.toLowerCase()); assert.equal(redeemed.edition, 'personal-pro'); assert.equal(codeRecord.redemptionCount, 1);
  await assert.rejects(service.redeem('user-1', issued.code), (error) => error?.response?.code === 'LICENSE_REDEEM_EXHAUSTED' || error?.response?.code === 'LICENSE_REDEEM_REPLAYED');
  await assert.rejects(service.redeem('user-2', issued.code), (error) => error?.response?.code === 'LICENSE_REDEEM_EXHAUSTED');
});
