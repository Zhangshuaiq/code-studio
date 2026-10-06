const assert = require('node:assert/strict');
const test = require('node:test');
const { API_NAMESPACES, EDITION_ENTITLEMENTS, entitlementsFor } = require('../dist');

test('community keeps all local capabilities without cloud dependencies', () => {
  const community = entitlementsFor('community');
  assert.equal(community.localProjects, true);
  assert.equal(community.localAgent, true);
  assert.equal(community.cloudSync, false);
  assert.equal(community.remoteExecution, false);
  assert.equal(community.enterprisePolicies, false);
});

test('enterprise adds governance without removing local ownership', () => {
  const enterprise = EDITION_ENTITLEMENTS.enterprise;
  assert.equal(enterprise.localProjects, true);
  assert.equal(enterprise.remoteExecution, true);
  assert.equal(enterprise.enterpriseRbac, true);
  assert.equal(enterprise.enterpriseAudit, true);
  assert.equal(enterprise.enterprisePolicies, true);
});

test('returned entitlements cannot mutate edition defaults', () => {
  const copy = entitlementsFor('community');
  copy.localProjects = false;
  assert.equal(EDITION_ENTITLEMENTS.community.localProjects, true);
});

test('local and control routes have explicit stable namespaces', () => {
  assert.equal(API_NAMESPACES.local, '/api/local');
  assert.equal(API_NAMESPACES.control, '/api/control');
});
