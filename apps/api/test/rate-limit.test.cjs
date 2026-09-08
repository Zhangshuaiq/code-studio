const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimitPolicy } = require('../dist/rate-limit/rate-limit.guard.js');

const config = { get: (_key, fallback) => fallback };

test('login and registration use the stricter authentication policy', () => {
  assert.deepEqual(rateLimitPolicy('/api/auth/login', 'POST', config), {
    name: 'auth', limit: 10, windowMs: 900000,
  });
  assert.equal(rateLimitPolicy('/api/auth/register', 'POST', config).name, 'auth');
});

test('other routes use the general distributed policy', () => {
  assert.deepEqual(rateLimitPolicy('/api/projects', 'GET', config), {
    name: 'general', limit: 300, windowMs: 60000,
  });
});
