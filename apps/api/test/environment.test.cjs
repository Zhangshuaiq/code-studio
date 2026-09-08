const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnvironment } = require('../dist/config/environment.js');

const valid = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app:secret@db:5432/app',
  CRED_ENCRYPTION_KEY: 'a'.repeat(64),
  JWT_SECRET: 'a-secure-random-production-secret-value',
  WEB_ORIGIN: 'https://code.example.com',
  SELF_REGISTRATION_ENABLED: 'false',
  INITIAL_ADMIN_TOKEN: 'a-secure-one-time-admin-setup-token',
};

test('production environment accepts strong required configuration', () => {
  assert.equal(validateEnvironment(valid).NODE_ENV, 'production');
});

test('production environment rejects weak secrets and unsafe origin', () => {
  assert.throws(
    () => validateEnvironment({ ...valid, JWT_SECRET: 'dev-secret', WEB_ORIGIN: '*' }),
    /JWT_SECRET[\s\S]*WEB_ORIGIN/,
  );
});

test('initial admin token is optional after setup but must be strong when configured', () => {
  assert.throws(
    () => validateEnvironment({ ...valid, INITIAL_ADMIN_TOKEN: 'short' }),
    /INITIAL_ADMIN_TOKEN/,
  );
  assert.doesNotThrow(
    () => validateEnvironment({ ...valid, INITIAL_ADMIN_TOKEN: '' }),
  );
});

test('environment rejects malformed database, numeric and boolean values', () => {
  assert.throws(
    () => validateEnvironment({
      ...valid,
      DATABASE_URL: 'mysql://db/app',
      API_PORT: '99999',
      AUTO_PREVIEW: 'yes',
    }),
    /DATABASE_URL[\s\S]*API_PORT[\s\S]*AUTO_PREVIEW/,
  );
});

test('redis defaults to standalone and production cluster requires three nodes', () => {
  assert.equal(validateEnvironment(valid).REDIS_MODE, undefined);
  assert.throws(
    () => validateEnvironment({ ...valid, REDIS_MODE: 'cluster', REDIS_CLUSTER_NODES: 'redis-0:6379' }),
    /至少配置 3 个发现节点/,
  );
  assert.equal(validateEnvironment({
    ...valid,
    REDIS_MODE: 'cluster',
    REDIS_CLUSTER_NODES: 'redis-0:6379,redis-1:6379,redis-2:6379',
  }).REDIS_MODE, 'cluster');
});

test('environment validates encryption key ids and previous key ring', () => {
  assert.throws(
    () => validateEnvironment({ ...valid, CRED_ENCRYPTION_KEY_ID: 'bad id' }),
    /CRED_ENCRYPTION_KEY_ID/,
  );
  assert.throws(
    () => validateEnvironment({ ...valid, CRED_ENCRYPTION_KEY_ID: 'v2', CRED_ENCRYPTION_PREVIOUS_KEYS: `v2:${'b'.repeat(64)}` }),
    /密钥 ID 重复/,
  );
});

test('environment validates JWT key ids and previous signing secrets', () => {
  assert.throws(
    () => validateEnvironment({ ...valid, JWT_KEY_ID: 'bad id' }),
    /JWT_KEY_ID/,
  );
  assert.throws(
    () => validateEnvironment({ ...valid, JWT_KEY_ID: 'v2', JWT_PREVIOUS_SECRETS: `v2:${'x'.repeat(32)}` }),
    /JWT 密钥 ID 重复/,
  );
});

test('kubernetes generation executor requires a shared workspace claim', () => {
  assert.throws(
    () => validateEnvironment({ ...valid, GENERATION_EXECUTOR: 'kubernetes' }),
    /K8S_GENERATION_WORKSPACE_CLAIM/,
  );
  assert.equal(validateEnvironment({
    ...valid,
    GENERATION_EXECUTOR: 'kubernetes',
    K8S_GENERATION_WORKSPACE_CLAIM: 'codegen-workspace',
  }).GENERATION_EXECUTOR, 'kubernetes');
  assert.throws(
    () => validateEnvironment({ ...valid, GENERATION_EXECUTOR: 'containerd' }),
    /GENERATION_EXECUTOR/,
  );
});
