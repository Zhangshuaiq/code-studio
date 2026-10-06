const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { EnterprisePolicyService } = require('../dist/enterprise-policy/enterprise-policy.service.js');
const { evaluatePolicy } = require('../../desktop/src/policy-verifier.cjs');

function fixture({ edition = 'enterprise', seatLimit = 2 } = {}) {
  const keys = crypto.generateKeyPairSync('ed25519'); const members = [];
  const organization = { id: 'org-1', name: 'Example Corp', slug: 'example', seatLimit, createdAt: new Date(), policy: { terminalEnabled: false, allowedModelEngines: ['codex-cli'], allowedConnectorTypes: ['postgres'], allowedGitHosts: ['github.com'], allowedNetworkHosts: ['api.example.com'], minimumClientVersion: '0.1.0', offlineDays: 7 } };
  const prisma = {
    organization: { findUnique: async () => organization, findUniqueOrThrow: async () => organization, create: async ({ data }) => ({ id: 'org-1', ...data }) },
    organizationMember: {
      count: async () => members.filter((item) => item.status === 'active').length,
      findUnique: async ({ where }) => members.find((item) => item.organizationId === where.organizationId_userId.organizationId && item.userId === where.organizationId_userId.userId) || null,
      findFirst: async () => members[0] ? { ...members[0], organization } : null,
      upsert: async ({ create, update }) => { let item = members.find((value) => value.userId === create.userId); if (item) Object.assign(item, update); else { item = { id: `member-${members.length + 1}`, status: 'active', ...create }; members.push(item); } return item; },
      delete: async ({ where }) => { const index = members.findIndex((item) => item.id === where.id); return members.splice(index, 1)[0]; },
    },
    enterprisePolicy: { upsert: async ({ create, update }) => ({ id: 'policy-1', ...(create || update) }) },
    licenseSubscription: { findUnique: async () => ({ edition, status: 'active', expiresAt: new Date(Date.now() + 86400_000) }) },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  prisma.$executeRaw = async () => 1;
  const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(); const config = { get: (key, fallback) => key === 'POLICY_ED25519_PRIVATE_KEY' ? privateKey : fallback };
  return { service: new EnterprisePolicyService(prisma, config), members, prisma, organization, publicKey: keys.publicKey };
}

test('enterprise policy is signed for an active organization member and accepted by desktop', async () => {
  const { service, publicKey } = fixture(); await service.addMember('org-1', { userId: '11111111-1111-4111-8111-111111111111', role: 'member' });
  const issued = await service.issueForUser('11111111-1111-4111-8111-111111111111'); const verified = evaluatePolicy(issued.token, { publicKey });
  assert.equal(verified.state, 'active'); assert.equal(verified.organizationId, 'org-1'); assert.equal(verified.policy.terminalEnabled, false); assert.deepEqual(verified.policy.allowedGitHosts, ['github.com']);
});

function invitationFixture(options) {
  const fixtureValue = fixture(options); const rows = [];
  fixtureValue.prisma.user = { findFirst: async () => null };
  const matches = (row, where) => Object.entries(where).every(([key, value]) => {
    if (key === 'expiresAt') return row.expiresAt > value.gt;
    if (key === 'email' && typeof value === 'object') return row.email !== value.not;
    return row[key] === value;
  });
  fixtureValue.prisma.organizationInvitation = {
    count: async ({ where }) => rows.filter((row) => matches(row, where)).length,
    create: async ({ data }) => { const row = { id: `invite-${rows.length}`, status: 'pending', createdAt: new Date(), ...data }; rows.push(row); return row; },
    findMany: async ({ where }) => rows.filter((row) => matches(row, where)),
    findUnique: async ({ where }) => { const row = rows.find((value) => value.tokenHash === where.tokenHash); return row ? { ...row, organization: fixtureValue.organization } : null; },
    updateMany: async ({ where, data }) => { const found = rows.filter((row) => matches(row, where)); found.forEach((row) => Object.assign(row, data)); return { count: found.length }; },
  };
  return { ...fixtureValue, rows };
}

test('invitations expose the token once, bind email, and reject replay and revoked or expired tokens', async () => {
  const { service, rows } = invitationFixture({ seatLimit: 5 });
  const user = { id: 'employee', email: 'Employee@Example.com' };
  const invitation = await service.createInvitation('org-1', 'admin', { email: 'employee@example.com' });
  assert.equal(invitation.tokenHash, undefined); assert.equal(rows[0].tokenHash, crypto.createHash('sha256').update(invitation.token).digest('hex'));
  assert.equal((await service.invitations('org-1'))[0].token, undefined); assert.equal((await service.invitations('org-1'))[0].tokenHash, undefined);
  await assert.rejects(service.acceptInvitation({ ...user, email: 'other@example.com' }, invitation.token), (error) => error.response.code === 'ORGANIZATION_INVITATION_EMAIL_MISMATCH');
  assert.equal((await service.acceptInvitation(user, invitation.token)).membership.userId, user.id);
  await assert.rejects(service.acceptInvitation(user, invitation.token), (error) => error.response.code === 'ORGANIZATION_INVITATION_INVALID');
  const revoked = await service.createInvitation('org-1', 'admin', { email: 'revoked@example.com' }); await service.revokeInvitation('org-1', revoked.id);
  await assert.rejects(service.acceptInvitation({ id: 'revoked', email: revoked.email }, revoked.token), (error) => error.response.code === 'ORGANIZATION_INVITATION_INVALID');
  const expired = await service.createInvitation('org-1', 'admin', { email: 'expired@example.com' }); rows.find((row) => row.id === expired.id).expiresAt = new Date(0);
  await assert.rejects(service.acceptInvitation({ id: 'expired', email: expired.email }, expired.token), (error) => error.response.code === 'ORGANIZATION_INVITATION_INVALID');
});

test('reissuing an invitation replaces its token and acceptance rechecks current seats', async () => {
  const { service, rows, members } = invitationFixture({ seatLimit: 1 });
  const first = await service.createInvitation('org-1', 'admin', { email: 'employee@example.com' });
  const second = await service.createInvitation('org-1', 'admin', { email: 'employee@example.com' });
  assert.notEqual(first.token, second.token); assert.equal(rows[0].status, 'revoked');
  await assert.rejects(service.createInvitation('org-1', 'admin', { email: 'another@example.com' }), (error) => error.response.code === 'ORGANIZATION_SEAT_LIMIT');
  members.push({ id: 'occupied', userId: 'occupied', organizationId: 'org-1', status: 'active' });
  await assert.rejects(service.acceptInvitation({ id: 'employee', email: 'employee@example.com' }, second.token), (error) => error.response.code === 'ORGANIZATION_SEAT_LIMIT');
  assert.equal(rows[1].status, 'pending');
});

test('organization seat limits and enterprise subscription are enforced', async () => {
  const { service } = fixture({ seatLimit: 1 }); await service.addMember('org-1', { userId: '11111111-1111-4111-8111-111111111111' });
  await assert.rejects(service.addMember('org-1', { userId: '22222222-2222-4222-8222-222222222222' }), (error) => error?.response?.code === 'ORGANIZATION_SEAT_LIMIT');
  const personal = fixture({ edition: 'personal-pro' }); await personal.service.addMember('org-1', { userId: '11111111-1111-4111-8111-111111111111' });
  await assert.rejects(personal.service.issueForUser('11111111-1111-4111-8111-111111111111'), (error) => error?.response?.code === 'ENTERPRISE_LICENSE_REQUIRED');
});
