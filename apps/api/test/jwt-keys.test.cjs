const test = require('node:test');
const assert = require('node:assert/strict');
const { buildJwtKeyRing, jwtKeyId } = require('../dist/auth/jwt-keys.js');

test('JWT key ring contains active and previous secrets', () => {
  const ring = buildJwtKeyRing({
    activeId: 'v2', activeSecret: 'n'.repeat(32), previous: `v1:${'o'.repeat(32)}`,
  });
  assert.equal(ring.keys.get('v2'), 'n'.repeat(32));
  assert.equal(ring.keys.get('v1'), 'o'.repeat(32));
});

test('JWT key id is extracted safely from a token header', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'v2' })).toString('base64url');
  assert.equal(jwtKeyId(`${header}.payload.signature`), 'v2');
  assert.equal(jwtKeyId('malformed'), undefined);
});

test('JWT key ring rejects duplicate ids', () => {
  assert.throws(
    () => buildJwtKeyRing({ activeId: 'v2', activeSecret: 'n'.repeat(32), previous: `v2:${'o'.repeat(32)}` }),
    /ID 重复/,
  );
});
