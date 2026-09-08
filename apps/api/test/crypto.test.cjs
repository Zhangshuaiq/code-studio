const test = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv, randomBytes } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { CryptoService } = require('../dist/crypto/crypto.service.js');

const oldKey = '1'.repeat(64);
const newKey = '2'.repeat(64);

function service(values) {
  return new CryptoService(new ConfigService(values));
}

function legacyEncrypt(plain, keyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
}

test('crypto envelope carries the active key id and round trips', () => {
  const crypto = service({ CRED_ENCRYPTION_KEY_ID: 'v2', CRED_ENCRYPTION_KEY: newKey });
  const blob = crypto.encrypt('secret');
  assert.match(blob, /^encv1\.v2\./);
  assert.equal(crypto.decrypt(blob), 'secret');
  assert.equal(crypto.needsRotation(blob), false);
});

test('legacy and previous-key ciphertext can be rotated to the active key', () => {
  const previous = service({ CRED_ENCRYPTION_KEY_ID: 'v1', CRED_ENCRYPTION_KEY: oldKey });
  const crypto = service({
    CRED_ENCRYPTION_KEY_ID: 'v2', CRED_ENCRYPTION_KEY: newKey,
    CRED_ENCRYPTION_PREVIOUS_KEYS: `v1:${oldKey}`,
  });
  for (const blob of [previous.encrypt('old'), legacyEncrypt('old', oldKey)]) {
    const rotated = crypto.rotate(blob);
    assert.match(rotated, /^encv1\.v2\./);
    assert.equal(crypto.decrypt(rotated), 'old');
  }
});

test('decrypt fails clearly when an envelope key is unavailable', () => {
  const blob = service({ CRED_ENCRYPTION_KEY_ID: 'v1', CRED_ENCRYPTION_KEY: oldKey }).encrypt('old');
  assert.throws(
    () => service({ CRED_ENCRYPTION_KEY_ID: 'v2', CRED_ENCRYPTION_KEY: newKey }).decrypt(blob),
    /缺少解密密钥: v1/,
  );
});
