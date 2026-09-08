const test = require('node:test');
const assert = require('node:assert/strict');
const { previewNamespaceName } = require('../dist/k8s/k8s.service.js');

test('preview namespace name is deterministic and DNS compliant', () => {
  assert.equal(previewNamespaceName('Codegen_Preview', 'TEAM_123'), 'codegen-preview-team-123');
  const long = previewNamespaceName('codegen-preview', 'a'.repeat(100));
  assert.equal(long.length, 63);
  assert.match(long, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
});

test('preview namespace rejects an unusable team id', () => {
  assert.throws(() => previewNamespaceName('preview', '___'), /Namespace/);
});
