const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { EnterprisePolicyService } = require('../dist/enterprise-policy/enterprise-policy.service.js');

test('PostgreSQL enforces concurrent seats, single-use invitations and exclusive domain claims', { skip: process.env.RUN_ENTERPRISE_DB_TESTS !== '1' }, async (t) => {
  const envFile = path.join(__dirname, '../.env');
  const configuration = fs.existsSync(envFile) ? require('dotenv').parse(fs.readFileSync(envFile)) : {};
  const databaseUrl = process.env.ENTERPRISE_TEST_DATABASE_URL || configuration.DATABASE_URL;
  assert.ok(databaseUrl, 'A test database URL is required');
  const schema = `enterprise_test_${crypto.randomBytes(8).toString('hex')}`;
  const connectionUrl = new URL(databaseUrl); connectionUrl.searchParams.delete('schema');
  const admin = new Client({ connectionString: connectionUrl.toString() }); await admin.connect();
  let prisma;
  t.after(async () => {
    await prisma?.$disconnect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  await admin.query('CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "email" TEXT UNIQUE, "username" TEXT, "displayName" TEXT)');
  await admin.query('CREATE TABLE "AuditLog" ("id" TEXT PRIMARY KEY, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "actorId" TEXT, "actorName" TEXT NOT NULL DEFAULT \'system\', "action" TEXT NOT NULL, "resourceType" TEXT, "resourceId" TEXT, "resourceName" TEXT, "result" TEXT NOT NULL DEFAULT \'success\', "ip" TEXT, "method" TEXT, "path" TEXT, "statusCode" INTEGER, "detail" JSONB, "searchText" TEXT NOT NULL DEFAULT \'\')');
  for (const migration of ['20260925210000_enterprise_policy_control', '20261006100000_organization_invitations', '20261006110000_organization_domains']) {
    await admin.query(fs.readFileSync(path.join(__dirname, '../prisma/migrations', migration, 'migration.sql'), 'utf8'));
  }
  const url = new URL(databaseUrl); url.searchParams.set('schema', schema);
  prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const service = new EnterprisePolicyService(prisma, { get: (_key, fallback) => fallback });
  const organizationActor = { actorId: 'platform-creator', actorName: 'Platform Creator', ip: '127.0.0.1', method: 'POST', path: '/admin/organizations' };
  await admin.query('ALTER TABLE "AuditLog" ADD CONSTRAINT "reject_organization_audit" CHECK ("action" <> \'organization.create\') NOT VALID');
  try { await assert.rejects(service.createOrganization({ name: 'Rejected Organization', slug: 'rejected-organization' }, organizationActor)); }
  finally { await admin.query('ALTER TABLE "AuditLog" DROP CONSTRAINT "reject_organization_audit"'); }
  assert.equal(await prisma.organization.count(), 0); assert.equal(await prisma.enterprisePolicy.count(), 0); assert.equal(await prisma.auditLog.count(), 0);
  const auditOrg = await service.createOrganization({ name: 'Audited Organization', slug: 'audited-organization' }, organizationActor);
  const organizationAudit = await prisma.auditLog.findFirst({ where: { action: 'organization.create', resourceId: auditOrg.id } });
  assert.equal(organizationAudit.actorId, organizationActor.actorId); assert.equal(organizationAudit.resourceName, auditOrg.name);
  assert.equal(organizationAudit.detail.before, null); assert.equal(organizationAudit.detail.after.policy.terminalEnabled, true);
  assert.deepEqual(organizationAudit.detail.after.verifiedDomains, []);
  const org = await service.createOrganization({ name: 'Concurrent Seats', slug: 'seats', seatLimit: 2 });
  const users = ['first', 'second', 'third'].map((id) => ({ id, email: `${id}@company.com` }));
  for (const user of users) await admin.query('INSERT INTO "User" ("id", "email", "username") VALUES ($1, $2, $3)', [user.id, user.email, user.id]);
  const invitations = await Promise.all(users.slice(0, 2).map((user) => service.createInvitation(org.id, 'admin', { email: user.email })));
  await prisma.organization.update({ where: { id: org.id }, data: { seatLimit: 1 } });
  const accepted = await Promise.allSettled(invitations.map((invitation, index) => service.acceptInvitation(users[index], invitation.token)));
  assert.equal(accepted.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(accepted.find((result) => result.status === 'rejected').reason.response.code, 'ORGANIZATION_SEAT_LIMIT');
  assert.equal(await prisma.organizationMember.count({ where: { organizationId: org.id } }), 1);
  const winner = accepted.findIndex((result) => result.status === 'fulfilled');
  await assert.rejects(service.acceptInvitation(users[winner], invitations[winner].token), (error) => error.response.code === 'ORGANIZATION_INVITATION_INVALID');
  await service.removeMember(org.id, users[winner].id);
  const inviteRace = await Promise.allSettled(users.map((user) => service.createInvitation(org.id, 'admin', { email: user.email })));
  // The remaining valid invitation continues to reserve the only seat.
  assert.equal(inviteRace.filter((result) => result.status === 'fulfilled').length, 1);

  const otherOrg = await service.createOrganization({ name: 'Second Organization', slug: 'second', seatLimit: 2 });
  const challenges = await Promise.all([service.createDomain(org.id, 'Company.com'), service.createDomain(otherOrg.id, 'company.com')]);
  const dns = new Map();
  service.resolveDomainTxt = async (host) => dns.get(host) || [];
  await assert.rejects(service.verifyDomain(org.id, challenges[0].id), (error) => error.response.code === 'ORGANIZATION_DOMAIN_TOKEN_MISMATCH');
  dns.set(challenges[0].recordName, challenges.map((challenge) => [challenge.recordValue.slice(0, 20), challenge.recordValue.slice(20)]));
  const verified = await Promise.allSettled([service.verifyDomain(org.id, challenges[0].id), service.verifyDomain(otherOrg.id, challenges[1].id)]);
  assert.equal(verified.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(verified.find((result) => result.status === 'rejected').reason.response.code, 'ORGANIZATION_DOMAIN_CLAIMED');
  const domainWinner = verified.findIndex((result) => result.status === 'fulfilled');
  const winnerOrg = domainWinner === 0 ? org : otherOrg;
  assert.deepEqual((await prisma.organization.findUnique({ where: { id: winnerOrg.id } })).verifiedDomains, ['company.com']);
  await service.removeDomain(winnerOrg.id, challenges[domainWinner].id);
  assert.deepEqual((await prisma.organization.findUnique({ where: { id: winnerOrg.id } })).verifiedDomains, []);
  const loser = domainWinner === 0 ? 1 : 0;
  assert.ok((await service.verifyDomain(loser === 0 ? org.id : otherOrg.id, challenges[loser].id)).verifiedAt);
  await assert.rejects(service.createDomain(org.id, 'http://company.com/path'), (error) => error.response.code === 'ORGANIZATION_DOMAIN_INVALID');
  await assert.rejects(service.createDomain(org.id, '127.0.0.1'), (error) => error.response.code === 'ORGANIZATION_DOMAIN_INVALID');
  const expired = await service.createDomain(org.id, 'expired.company.com');
  await prisma.organizationDomain.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
  await assert.rejects(service.verifyDomain(org.id, expired.id), (error) => error.response.code === 'ORGANIZATION_DOMAIN_EXPIRED');
  const stale = await service.createDomain(org.id, 'stale.company.com');
  service.resolveDomainTxt = async () => {
    await service.createDomain(org.id, 'stale.company.com');
    return [[stale.recordValue]];
  };
  await assert.rejects(service.verifyDomain(org.id, stale.id));
  assert.equal((await prisma.organizationDomain.findUnique({ where: { id: stale.id } })).verifiedAt, null);
  service.resolveDomainTxt = async () => { throw new Error('DNS unavailable'); };
  await assert.rejects(service.verifyDomain(org.id, stale.id), (error) => error.response.code === 'ORGANIZATION_DOMAIN_DNS_UNAVAILABLE');
  const more = await Promise.all(['one.company.com', 'two.company.com'].map((domain) => service.createDomain(org.id, domain)));
  service.resolveDomainTxt = async (host) => more.filter((row) => row.recordName === host).map((row) => [row.recordValue]);
  await Promise.all(more.map((row) => service.verifyDomain(org.id, row.id)));
  const finalDomains = (await prisma.organization.findUnique({ where: { id: org.id } })).verifiedDomains;
  assert.ok(finalDomains.includes('one.company.com')); assert.ok(finalDomains.includes('two.company.com'));
  const roleOrg = await service.createOrganization({ name: 'Organization Roles', slug: 'roles', seatLimit: 10 });
  await service.addMember(roleOrg.id, { userId: users[0].id, role: 'owner' });
  await service.addMember(roleOrg.id, { userId: users[1].id, role: 'owner' });
  await service.addMember(roleOrg.id, { userId: users[2].id, role: 'admin' });
  assert.equal((await service.managedMembers(roleOrg.id, users[0].id)).length, 3);
  await assert.rejects(service.managedMembers(roleOrg.id, 'outsider'), (error) => error.response.code === 'ORGANIZATION_MANAGEMENT_FORBIDDEN');
  await assert.rejects(service.removeMember(roleOrg.id, users[0].id, users[2].id), (error) => error.response.code === 'ORGANIZATION_ROLE_FORBIDDEN');
  const leaderInvitation = await service.createInvitation(roleOrg.id, users[0].id, { email: 'leader@company.com', role: 'admin' }, users[0].id);
  await assert.rejects(service.createInvitation(roleOrg.id, users[2].id, { email: 'leader@company.com', role: 'member' }, users[2].id), (error) => error.response.code === 'ORGANIZATION_ROLE_FORBIDDEN');
  await assert.rejects(service.revokeInvitation(roleOrg.id, leaderInvitation.id, users[2].id), (error) => error.response.code === 'ORGANIZATION_ROLE_FORBIDDEN');
  const staffInvitation = await service.createInvitation(roleOrg.id, users[2].id, { email: 'staff@company.com' }, users[2].id);
  assert.ok((await service.invitations(roleOrg.id, users[2].id)).every((item) => !item.token && !item.tokenHash));
  await service.revokeInvitation(roleOrg.id, staffInvitation.id, users[2].id);
  assert.equal((await prisma.organizationInvitation.findUnique({ where: { id: staffInvitation.id } })).status, 'revoked');
  const demotions = await Promise.allSettled(users.slice(0, 2).map((user) => service.updateMemberRole(roleOrg.id, user.id, 'member')));
  assert.equal(demotions.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(demotions.find((result) => result.status === 'rejected').reason.response.code, 'ORGANIZATION_LAST_OWNER');
  const remainingOwner = await prisma.organizationMember.findFirst({ where: { organizationId: roleOrg.id, role: 'owner', status: 'active' } });
  await assert.rejects(service.removeMember(roleOrg.id, remainingOwner.userId), (error) => error.response.code === 'ORGANIZATION_LAST_OWNER');
  await assert.rejects(service.addMember(roleOrg.id, { userId: remainingOwner.userId, role: 'member' }), (error) => error.response.code === 'ORGANIZATION_LAST_OWNER');
  const managedDomain = await service.createDomain(roleOrg.id, 'managed.company.com', remainingOwner.userId);
  assert.ok((await service.domains(roleOrg.id, users[2].id)).some((row) => row.id === managedDomain.id));
  const ordinary = users.slice(0, 2).find((user) => user.id !== remainingOwner.userId);
  for (const actorId of [ordinary.id, 'outsider']) {
    await assert.rejects(service.domains(roleOrg.id, actorId), (error) => error.status === 403);
    await assert.rejects(service.createDomain(roleOrg.id, 'forbidden.company.com', actorId), (error) => error.status === 403);
    await assert.rejects(service.verifyDomain(roleOrg.id, managedDomain.id, actorId), (error) => error.status === 403);
    await assert.rejects(service.removeDomain(roleOrg.id, managedDomain.id, actorId), (error) => error.status === 403);
  }
  await assert.rejects(service.domains(otherOrg.id, remainingOwner.userId), (error) => error.status === 403);
  await assert.rejects(service.createDomain(otherOrg.id, 'foreign.company.com', remainingOwner.userId), (error) => error.status === 403);
  await assert.rejects(service.verifyDomain(otherOrg.id, managedDomain.id, remainingOwner.userId), (error) => error.status === 403);
  await assert.rejects(service.removeDomain(otherOrg.id, managedDomain.id, remainingOwner.userId), (error) => error.status === 403);
  // Authority lost while DNS is in flight must prevent verification writes.
  service.resolveDomainTxt = async () => {
    await service.updateMemberRole(roleOrg.id, users[2].id, 'member', remainingOwner.userId);
    return [[managedDomain.recordValue]];
  };
  await assert.rejects(service.verifyDomain(roleOrg.id, managedDomain.id, users[2].id), (error) => error.status === 403);
  assert.equal((await prisma.organizationDomain.findUnique({ where: { id: managedDomain.id } })).verifiedAt, null);
  assert.ok(!(await prisma.organization.findUnique({ where: { id: roleOrg.id } })).verifiedDomains.includes(managedDomain.domain));
  await service.updateMemberRole(roleOrg.id, users[2].id, 'admin', remainingOwner.userId);
  service.resolveDomainTxt = async () => [[managedDomain.recordValue]];
  assert.ok((await service.verifyDomain(roleOrg.id, managedDomain.id, users[2].id)).verifiedAt);
  await prisma.organizationMember.update({ where: { organizationId_userId: { organizationId: roleOrg.id, userId: users[2].id } }, data: { status: 'disabled' } });
  await assert.rejects(service.domains(roleOrg.id, users[2].id), (error) => error.status === 403);
  await assert.rejects(service.removeDomain(roleOrg.id, managedDomain.id, users[2].id), (error) => error.status === 403);
  await prisma.organizationMember.update({ where: { organizationId_userId: { organizationId: roleOrg.id, userId: users[2].id } }, data: { status: 'active' } });
  await service.removeDomain(roleOrg.id, managedDomain.id, users[2].id);
  assert.equal(await prisma.organizationDomain.findUnique({ where: { id: managedDomain.id } }), null);
  const originalPolicy = await service.managedPolicy(roleOrg.id, remainingOwner.userId);
  assert.equal((await service.managedPolicy(roleOrg.id, users[2].id)).id, originalPolicy.id);
  for (const actor of [ordinary.id, 'outsider']) await assert.rejects(service.managedPolicy(roleOrg.id, actor), (error) => error.status === 403);
  await assert.rejects(service.managedPolicy(otherOrg.id, remainingOwner.userId), (error) => error.status === 403);
  const policyInput = { terminalEnabled: false, allowedModelEngines: ['codex-cli'], allowedConnectorTypes: ['postgres'], allowedGitHosts: ['local'], allowedNetworkHosts: [], minimumClientVersion: '0.1.0', offlineDays: 3 };
  await assert.rejects(service.updatePolicy(roleOrg.id, policyInput, users[2].id, originalPolicy.updatedAt.toISOString()), (error) => error.response.code === 'ORGANIZATION_POLICY_FORBIDDEN');
  const policyRace = await Promise.allSettled([2, 4].map((offlineDays) => service.updatePolicy(roleOrg.id, { ...policyInput, offlineDays }, remainingOwner.userId, originalPolicy.updatedAt.toISOString())));
  assert.equal(policyRace.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(policyRace.find((row) => row.status === 'rejected').reason.response.code, 'ORGANIZATION_POLICY_CONFLICT');
  const winningPolicy = await service.managedPolicy(roleOrg.id, remainingOwner.userId);
  assert.ok(winningPolicy.updatedAt > originalPolicy.updatedAt);
  const policyRaceRows = await prisma.auditLog.findMany({ where: { resourceId: roleOrg.id, action: 'organization.policy.update' } });
  assert.equal(policyRaceRows.length, 1, 'only the winning policy transaction records success');
  assert.equal(policyRaceRows[0].detail.before.updatedAt, originalPolicy.updatedAt.toISOString());
  assert.equal(policyRaceRows[0].detail.after.updatedAt, winningPolicy.updatedAt.toISOString());
  assert.equal(policyRaceRows[0].detail.after.offlineDays, winningPolicy.offlineDays);
  await service.updatePolicy(roleOrg.id, { ...policyInput, offlineDays: 6 });
  await assert.rejects(service.updatePolicy(roleOrg.id, policyInput, remainingOwner.userId, winningPolicy.updatedAt.toISOString()), (error) => error.response.code === 'ORGANIZATION_POLICY_CONFLICT');
  // Real atomic permission/evidence writes, including database-side failure.
  const atomicOrg = await service.createOrganization({ name: 'Atomic Audit', slug: 'atomic-audit', seatLimit: 10 });
  const actorContext = { actorId: 'platform-operator', actorName: 'Platform Operator', ip: '127.0.0.1', method: 'POST', path: '/admin/organizations/members' };
  await service.addMember(atomicOrg.id, { userId: users[0].id, role: 'owner' }, actorContext);
  await service.addMember(atomicOrg.id, { userId: users[1].id, role: 'member' }, actorContext);
  await service.updateMemberRole(atomicOrg.id, users[1].id, 'admin', undefined, { ...actorContext, method: 'PUT' });
  const roleEntry = await prisma.auditLog.findFirst({ where: { resourceId: atomicOrg.id, action: 'organization.member.role.update' } });
  assert.equal(roleEntry.actorId, 'platform-operator'); assert.equal(roleEntry.detail.before.role, 'member'); assert.equal(roleEntry.detail.after.role, 'admin');
  assert.equal(roleEntry.detail.transactional, true); assert.equal(roleEntry.method, 'PUT');
  assert.deepEqual(Object.keys(roleEntry.detail.before).sort(), ['id', 'organizationId', 'role', 'status', 'userId']);
  // Platform operator is deliberately not an organization member. This must
  // not conflate audit identity with organization-manager authorization.
  for (const [action, operation] of [
    ['organization.member.add', () => service.addMember(atomicOrg.id, { userId: users[2].id }, actorContext)],
    ['organization.member.role.update', () => service.updateMemberRole(atomicOrg.id, users[1].id, 'member', undefined, actorContext)],
    ['organization.member.remove', () => service.removeMember(atomicOrg.id, users[1].id, undefined, actorContext)],
  ]) {
    const membersBefore = await prisma.organizationMember.findMany({ where: { organizationId: atomicOrg.id }, orderBy: { id: 'asc' } });
    const auditCountBefore = await prisma.auditLog.count();
    await admin.query(`ALTER TABLE "AuditLog" ADD CONSTRAINT "reject_atomic_audit" CHECK ("action" <> '${action}') NOT VALID`);
    try { await assert.rejects(operation()); }
    finally { await admin.query('ALTER TABLE "AuditLog" DROP CONSTRAINT "reject_atomic_audit"'); }
    assert.deepEqual(await prisma.organizationMember.findMany({ where: { organizationId: atomicOrg.id }, orderBy: { id: 'asc' } }), membersBefore, action);
    assert.equal(await prisma.auditLog.count(), auditCountBefore, action);
  }
  await service.removeMember(atomicOrg.id, users[1].id, undefined, { ...actorContext, method: 'DELETE' });
  const removedEntry = await prisma.auditLog.findFirst({ where: { resourceId: atomicOrg.id, action: 'organization.member.remove' } });
  assert.equal(removedEntry.detail.before.role, 'admin'); assert.equal(removedEntry.detail.after, null);
  const atomicPolicy = await prisma.enterprisePolicy.findUnique({ where: { organizationId: atomicOrg.id } });
  for (const actorId of [undefined, users[0].id]) {
    const auditCountBefore = await prisma.auditLog.count();
    await admin.query('ALTER TABLE "AuditLog" ADD CONSTRAINT "reject_policy_audit" CHECK ("action" <> \'organization.policy.update\') NOT VALID');
    try { await assert.rejects(service.updatePolicy(atomicOrg.id, { ...policyInput, offlineDays: 8 }, actorId, atomicPolicy.updatedAt.toISOString(), actorContext)); }
    finally { await admin.query('ALTER TABLE "AuditLog" DROP CONSTRAINT "reject_policy_audit"'); }
    assert.deepEqual(await prisma.enterprisePolicy.findUnique({ where: { organizationId: atomicOrg.id } }), atomicPolicy, 'audit rejection rolls policy and version back');
    assert.equal(await prisma.auditLog.count(), auditCountBefore);
  }
  await service.updatePolicy(atomicOrg.id, { ...policyInput, offlineDays: 8 }, undefined, undefined, { ...actorContext, method: 'PUT' });
  const atomicPolicyRow = await prisma.auditLog.findFirst({ where: { resourceId: atomicOrg.id, action: 'organization.policy.update' } });
  assert.equal(atomicPolicyRow.actorId, 'platform-operator'); assert.equal(atomicPolicyRow.detail.before.offlineDays, atomicPolicy.offlineDays);
  assert.equal(atomicPolicyRow.detail.after.offlineDays, 8); assert.equal(atomicPolicyRow.detail.transactional, true);
  assert.deepEqual(Object.keys(atomicPolicyRow.detail.after).sort(), ['allowedConnectorTypes', 'allowedGitHosts', 'allowedModelEngines', 'allowedNetworkHosts', 'minimumClientVersion', 'offlineDays', 'terminalEnabled', 'updatedAt']);
  // A platform upsert may also restore a missing policy; failed audit must not
  // leave even that new row behind. This deletion is only in the test schema.
  await prisma.enterprisePolicy.delete({ where: { organizationId: atomicOrg.id } });
  const policyCreateAuditCount = await prisma.auditLog.count();
  await admin.query('ALTER TABLE "AuditLog" ADD CONSTRAINT "reject_policy_audit" CHECK ("action" <> \'organization.policy.update\') NOT VALID');
  try { await assert.rejects(service.updatePolicy(atomicOrg.id, policyInput, undefined, undefined, actorContext)); }
  finally { await admin.query('ALTER TABLE "AuditLog" DROP CONSTRAINT "reject_policy_audit"'); }
  assert.equal(await prisma.enterprisePolicy.findUnique({ where: { organizationId: atomicOrg.id } }), null);
  assert.equal(await prisma.auditLog.count(), policyCreateAuditCount);
  const restoredPolicy = await service.updatePolicy(atomicOrg.id, policyInput, undefined, undefined, actorContext);
  const restoredEntry = await prisma.auditLog.findFirst({ where: { resourceId: atomicOrg.id, action: 'organization.policy.update' }, orderBy: { createdAt: 'desc' } });
  assert.equal(restoredEntry.detail.before, null); assert.equal(restoredEntry.detail.after.updatedAt, restoredPolicy.updatedAt.toISOString());
  const initialInvite = await service.createInvitation(atomicOrg.id, 'platform-operator', { email: users[2].email }, undefined, actorContext);
  for (const [action, operation] of [
    ['organization.invitation.create', () => service.createInvitation(atomicOrg.id, 'platform-operator', { email: users[2].email }, undefined, actorContext)],
    ['organization.invitation.revoke', () => service.revokeInvitation(atomicOrg.id, initialInvite.id, undefined, actorContext)],
    ['organization.invitation.accept', () => service.acceptInvitation(users[2], initialInvite.token)],
  ]) {
    const invitationsBefore = await prisma.organizationInvitation.findMany({ where: { organizationId: atomicOrg.id }, orderBy: { id: 'asc' } });
    const membersBefore = await prisma.organizationMember.findMany({ where: { organizationId: atomicOrg.id }, orderBy: { id: 'asc' } });
    const auditCountBefore = await prisma.auditLog.count();
    await admin.query(`ALTER TABLE "AuditLog" ADD CONSTRAINT "reject_invitation_audit" CHECK ("action" <> '${action}') NOT VALID`);
    try { await assert.rejects(operation()); }
    finally { await admin.query('ALTER TABLE "AuditLog" DROP CONSTRAINT "reject_invitation_audit"'); }
    assert.deepEqual(await prisma.organizationInvitation.findMany({ where: { organizationId: atomicOrg.id }, orderBy: { id: 'asc' } }), invitationsBefore, action);
    assert.deepEqual(await prisma.organizationMember.findMany({ where: { organizationId: atomicOrg.id }, orderBy: { id: 'asc' } }), membersBefore, action);
    assert.equal(await prisma.auditLog.count(), auditCountBefore, action);
  }
  const replacement = await service.createInvitation(atomicOrg.id, 'platform-operator', { email: users[2].email }, undefined, actorContext);
  const replacementAudit = await prisma.auditLog.findFirst({ where: { resourceId: atomicOrg.id, action: 'organization.invitation.create' }, orderBy: { createdAt: 'desc' } });
  assert.equal(replacementAudit.detail.before.invitations[0].id, initialInvite.id);
  assert.equal(replacementAudit.detail.before.invitations[0].status, 'pending');
  assert.equal(replacementAudit.detail.after.invitations.find(row => row.id === initialInvite.id).status, 'revoked');
  assert.equal(replacementAudit.detail.after.invitations.find(row => row.id === replacement.id).status, 'pending');
  await assert.rejects(service.acceptInvitation(users[2], initialInvite.token), error => error.response.code === 'ORGANIZATION_INVITATION_INVALID');
  const acceptRace = await Promise.allSettled([1, 2].map(() => service.acceptInvitation({ ...users[2], username: 'Employee' }, replacement.token, { actorId: 'forged', actorName: 'Employee' })));
  assert.equal(acceptRace.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(acceptRace.find(row => row.status === 'rejected').reason.response.code, 'ORGANIZATION_INVITATION_INVALID');
  const acceptAudit = await prisma.auditLog.findMany({ where: { resourceId: atomicOrg.id, action: 'organization.invitation.accept' } });
  assert.equal(acceptAudit.length, 1); assert.equal(acceptAudit[0].actorId, users[2].id); assert.equal(acceptAudit[0].actorName, 'Employee');
  assert.equal(acceptAudit[0].detail.before.invitation.status, 'pending'); assert.equal(acceptAudit[0].detail.before.membership, null);
  assert.equal(acceptAudit[0].detail.after.invitation.status, 'accepted'); assert.equal(acceptAudit[0].detail.after.membership.userId, users[2].id);
  const revokeTarget = await service.createInvitation(atomicOrg.id, 'platform-operator', { email: 'revoke-recipient@company.com' }, undefined, actorContext);
  await service.revokeInvitation(atomicOrg.id, revokeTarget.id, undefined, actorContext);
  const revokeAudit = await prisma.auditLog.findFirst({ where: { resourceId: atomicOrg.id, action: 'organization.invitation.revoke' } });
  assert.equal(revokeAudit.detail.before.status, 'pending'); assert.equal(revokeAudit.detail.after.status, 'revoked');
  const invitationAuditRows = await prisma.auditLog.findMany({ where: { resourceId: atomicOrg.id, action: { startsWith: 'organization.invitation.' } } });
  const invitationAuditText = JSON.stringify(invitationAuditRows);
  for (const secret of [users[2].email, 'revoke-recipient@company.com', initialInvite.token, replacement.token, revokeTarget.token, crypto.createHash('sha256').update(replacement.token).digest('hex')]) assert.ok(!invitationAuditText.includes(secret), 'invitation audit must exclude recipient, token and hash');
  const atomicDomainName = 'atomic.company.com';
  const dnsBeforeAtomicDomain = service.resolveDomainTxt;
  let atomicDnsReads = 0;
  service.resolveDomainTxt = async () => { atomicDnsReads++; const row = await prisma.organizationDomain.findFirst({ where: { organizationId: atomicOrg.id, domain: atomicDomainName } }); return [[`code-studio-verification=${row.token}`]]; };
  const rejectDomainAudit = async (action, operation) => {
    const domainsBefore = await prisma.organizationDomain.findMany({ where: { organizationId: atomicOrg.id }, orderBy: { id: 'asc' } });
    const organizationBefore = await prisma.organization.findUnique({ where: { id: atomicOrg.id } });
    const countBefore = await prisma.auditLog.count();
    await admin.query(`ALTER TABLE "AuditLog" ADD CONSTRAINT "reject_domain_audit" CHECK ("action" <> '${action}') NOT VALID`);
    try { await assert.rejects(operation()); }
    finally { await admin.query('ALTER TABLE "AuditLog" DROP CONSTRAINT "reject_domain_audit"'); }
    assert.deepEqual(await prisma.organizationDomain.findMany({ where: { organizationId: atomicOrg.id }, orderBy: { id: 'asc' } }), domainsBefore, action);
    assert.deepEqual(await prisma.organization.findUnique({ where: { id: atomicOrg.id } }), organizationBefore, action);
    assert.equal(await prisma.auditLog.count(), countBefore, action);
  };
  await rejectDomainAudit('organization.domain.create', () => service.createDomain(atomicOrg.id, atomicDomainName, undefined, organizationActor));
  const atomicDomain = await service.createDomain(atomicOrg.id, atomicDomainName, undefined, organizationActor);
  await rejectDomainAudit('organization.domain.create', () => service.createDomain(atomicOrg.id, atomicDomainName, undefined, organizationActor));
  await rejectDomainAudit('organization.domain.verify', () => service.verifyDomain(atomicOrg.id, atomicDomain.id, undefined, organizationActor));
  const verifiedAtomicDomain = await service.verifyDomain(atomicOrg.id, atomicDomain.id, undefined, organizationActor);
  const verifyAudit = await prisma.auditLog.findFirst({ where: { resourceId: atomicOrg.id, action: 'organization.domain.verify' } });
  assert.equal(verifyAudit.detail.before.domain.verifiedAt, null); assert.equal(verifyAudit.detail.after.domain.verifiedAt, verifiedAtomicDomain.verifiedAt.toISOString());
  assert.deepEqual(verifyAudit.detail.before.verifiedDomains, []); assert.deepEqual(verifyAudit.detail.after.verifiedDomains, [atomicDomainName]);
  const dnsReadsAtVerified = atomicDnsReads;
  await service.verifyDomain(atomicOrg.id, atomicDomain.id, undefined, organizationActor);
  await service.createDomain(atomicOrg.id, atomicDomainName, undefined, organizationActor);
  assert.equal(atomicDnsReads, dnsReadsAtVerified, 'verified-domain idempotence must not repeat DNS');
  assert.equal(await prisma.auditLog.count({ where: { resourceId: atomicOrg.id, action: 'organization.domain.verify' } }), 2);
  await rejectDomainAudit('organization.domain.remove', () => service.removeDomain(atomicOrg.id, atomicDomain.id, undefined, organizationActor));
  await service.removeDomain(atomicOrg.id, atomicDomain.id, undefined, organizationActor);
  const removeAudit = await prisma.auditLog.findFirst({ where: { resourceId: atomicOrg.id, action: 'organization.domain.remove' } });
  assert.equal(removeAudit.detail.after.domain, null); assert.deepEqual(removeAudit.detail.before.verifiedDomains, [atomicDomainName]); assert.deepEqual(removeAudit.detail.after.verifiedDomains, []);
  const domainAuditRows = await prisma.auditLog.findMany({ where: { resourceId: atomicOrg.id, action: { startsWith: 'organization.domain.' } } });
  const domainAuditText = JSON.stringify(domainAuditRows);
  for (const secret of [atomicDomain.token, atomicDomain.recordValue]) assert.ok(!domainAuditText.includes(secret));
  assert.deepEqual(Object.keys(verifyAudit.detail.after.domain).sort(), ['domain', 'expiresAt', 'id', 'organizationId', 'verifiedAt']);
  service.resolveDomainTxt = dnsBeforeAtomicDomain;
  await service.addMember(atomicOrg.id, { userId: users[1].id, role: 'auditor' }, organizationActor);
  await service.updateMemberRole(atomicOrg.id, users[2].id, 'admin', users[0].id);
  await assert.rejects(service.updateMemberRole(atomicOrg.id, users[0].id, 'auditor', users[0].id), error => error.response.code === 'ORGANIZATION_LAST_OWNER');
  await assert.rejects(service.updateMemberRole(atomicOrg.id, users[1].id, 'member', users[2].id), error => error.response.code === 'ORGANIZATION_ROLE_FORBIDDEN');
  await assert.rejects(service.removeMember(atomicOrg.id, users[1].id, users[2].id), error => error.response.code === 'ORGANIZATION_ROLE_FORBIDDEN');
  const protectedAuditInvite = await service.createInvitation(atomicOrg.id, users[0].id, { email: 'auditor-invite@company.com', role: 'auditor' }, users[0].id);
  await assert.rejects(service.createInvitation(atomicOrg.id, users[2].id, { email: protectedAuditInvite.email, role: 'member' }, users[2].id), error => error.response.code === 'ORGANIZATION_ROLE_FORBIDDEN');
  await assert.rejects(service.revokeInvitation(atomicOrg.id, protectedAuditInvite.id, users[2].id), error => error.response.code === 'ORGANIZATION_ROLE_FORBIDDEN');
  const auditorRecords = await service.organizationAudit(atomicOrg.id, users[1].id);
  assert.ok(auditorRecords.total > 0); assert.ok(auditorRecords.items.every(row => row.resourceId === atomicOrg.id && !('ip' in row) && !('path' in row)));
  await assert.rejects(service.organizationAudit(otherOrg.id, users[1].id), error => error.status === 403);
  const auditorMembersBefore = await prisma.organizationMember.findMany({ where: { organizationId: atomicOrg.id }, orderBy: { id: 'asc' } });
  const auditorAuditCountBefore = await prisma.auditLog.count();
  for (const operation of [
    () => service.managedMembers(atomicOrg.id, users[1].id), () => service.invitations(atomicOrg.id, users[1].id),
    () => service.domains(atomicOrg.id, users[1].id), () => service.managedPolicy(atomicOrg.id, users[1].id),
    () => service.updateMemberRole(atomicOrg.id, users[0].id, 'member', users[1].id), () => service.removeMember(atomicOrg.id, users[0].id, users[1].id),
    () => service.createInvitation(atomicOrg.id, users[1].id, { email: 'denied-auditor@company.com' }, users[1].id), () => service.revokeInvitation(atomicOrg.id, initialInvite.id, users[1].id),
    () => service.createDomain(atomicOrg.id, 'denied.company.com', users[1].id), () => service.verifyDomain(atomicOrg.id, atomicDomain.id, users[1].id), () => service.removeDomain(atomicOrg.id, atomicDomain.id, users[1].id),
    () => service.updatePolicy(atomicOrg.id, policyInput, users[1].id, restoredPolicy.updatedAt.toISOString()),
  ]) await assert.rejects(operation(), error => error.status === 403);
  assert.deepEqual(await prisma.organizationMember.findMany({ where: { organizationId: atomicOrg.id }, orderBy: { id: 'asc' } }), auditorMembersBefore);
  assert.equal(await prisma.auditLog.count(), auditorAuditCountBefore);
  await service.updateMemberRole(atomicOrg.id, users[1].id, 'member', users[0].id);
  await assert.rejects(service.organizationAudit(atomicOrg.id, users[1].id), error => error.status === 403);
  await service.updateMemberRole(atomicOrg.id, users[1].id, 'auditor', users[0].id);
  await prisma.organizationMember.update({ where: { organizationId_userId: { organizationId: atomicOrg.id, userId: users[1].id } }, data: { status: 'suspended' } });
  await assert.rejects(service.organizationAudit(atomicOrg.id, users[1].id), error => error.status === 403);
  // Reset only audit fixtures in this isolated, random test schema. Existing
  // interceptor/snapshot assertions below expect a fresh audit fixture.
  await prisma.auditLog.deleteMany();
  // Persist actual interceptor events through the production AuditService in
  // the isolated schema. Request/response secrets must not enter searchable data.
  const { AuditService } = require('../dist/audit/audit.service.js');
  const { AuditInterceptor } = require('../dist/audit/audit.interceptor.js'); const { Reflector } = require('@nestjs/core'); const { defer, lastValueFrom } = require('rxjs');
  const { EnterprisePolicyController } = require('../dist/enterprise-policy/enterprise-policy.controller.js');
  const auditService = new AuditService(prisma); const interceptor = new AuditInterceptor(new Reflector(), auditService);
  const body = { email: 'private-audit@company.com', role: 'member', token: 'request-secret' };
  const request = { params: { id: roleOrg.id }, body, user: { id: remainingOwner.userId, username: 'Owner' }, originalUrl: `/control/enterprise/organizations/${roleOrg.id}/invitations?token=query-secret`, method: 'POST', ip: '127.0.0.1' };
  const context = { getClass: () => EnterprisePolicyController, getHandler: () => EnterprisePolicyController.prototype.inviteMember, switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 201 }) }) };
  const controller = new EnterprisePolicyController(service);
  const invited = await lastValueFrom(interceptor.intercept(context, { handle: () => defer(() => controller.inviteMember(request.user, roleOrg.id, body, request)) }));
  let auditRows = [];
  for (let i = 0; i < 100; i++) { auditRows = await prisma.auditLog.findMany(); if (auditRows.length) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(auditRows.length, 1); assert.equal(auditRows[0].resourceId, roleOrg.id); assert.equal(auditRows[0].actorId, remainingOwner.userId);
  assert.equal(auditRows[0].detail.outcome.invitationId, invited.id); assert.equal(auditRows[0].detail.outcome.role, 'member');
  const serialized = JSON.stringify(auditRows); for (const secret of [invited.token, 'request-secret', 'query-secret', body.email]) assert.ok(!serialized.includes(secret));
  const searched = await auditService.search({ action: 'organization.invitation.create', resourceType: 'organization', result: 'success' }); assert.equal(searched.total, 1);
  Object.assign(request, { params: { id: roleOrg.id, userId: remainingOwner.userId }, body: { role: 'member', token: 'failed-request-secret' }, originalUrl: `/control/enterprise/organizations/${roleOrg.id}/members/${remainingOwner.userId}/role`, method: 'PUT' });
  const failureContext = { ...context, getHandler: () => EnterprisePolicyController.prototype.changeRole };
  await assert.rejects(lastValueFrom(interceptor.intercept(failureContext, { handle: () => defer(() => service.updateMemberRole(roleOrg.id, remainingOwner.userId, 'member', remainingOwner.userId)) })), (error) => error.response.code === 'ORGANIZATION_LAST_OWNER');
  let failed;
  // Audit persistence is async. Wait for a committed row in a fresh snapshot.
  for (let i = 0; i < 100; i++) { failed = await auditService.search({ action: 'organization.member.role.update', result: 'failure' }); if (failed.total && failed.items.length) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(failed.total, 1); assert.equal(failed.items[0].statusCode, 403); assert.equal(failed.items[0].detail.targets.userId, remainingOwner.userId); assert.ok(!JSON.stringify(failed).includes('failed-request-secret'));
  // Decoy rows prove tenant, resource type and action namespace isolation in SQL.
  const source = auditRows[0];
  for (const data of [
    { resourceId: otherOrg.id }, { resourceType: 'user' }, { action: 'user.delete' },
  ]) await prisma.auditLog.create({ data: { actorId: source.actorId, actorName: 'Decoy', action: source.action, resourceType: 'organization', resourceId: roleOrg.id, result: 'success', method: 'POST', path: '/private', statusCode: 200, searchText: 'decoy', ...data } });
  const scoped = await service.organizationAudit(roleOrg.id, remainingOwner.userId);
  assert.equal(scoped.total, 2); assert.ok(scoped.items.every((row) => row.actorName === 'Owner'));
  assert.ok(scoped.items.every((row) => !('ip' in row) && !('path' in row) && !('searchText' in row)));
  const firstPage = await service.organizationAudit(roleOrg.id, users[2].id, { pageSize: 1 });
  const secondPage = await service.organizationAudit(roleOrg.id, users[2].id, { pageSize: 1, page: 2 });
  assert.equal(firstPage.total, 2); assert.equal(secondPage.items.length, 1); assert.notEqual(firstPage.items[0].id, secondPage.items[0].id);
  assert.equal((await service.organizationAudit(roleOrg.id, remainingOwner.userId, { result: 'failure' })).total, 1);
  assert.equal((await service.organizationAudit(roleOrg.id, remainingOwner.userId, { actor: 'Owner', action: 'organization.invitation.create' })).total, 1);
  assert.equal((await service.organizationAudit(roleOrg.id, remainingOwner.userId, { q: 'decoy' })).total, 0);
  const ordinaryUser = users.slice(0, 2).find((user) => user.id !== remainingOwner.userId);
  for (const userId of [ordinaryUser.id, 'outsider']) await assert.rejects(service.organizationAudit(roleOrg.id, userId), (error) => error.status === 403);
  await assert.rejects(service.organizationAudit(otherOrg.id, remainingOwner.userId), (error) => error.status === 403);
  // Force an independent committed insert between list and count. The normal
  // production query must retain its first snapshot, then see it on next read.
  for (const mode of ['organization', 'platform', 'read-committed-control']) {
    const marker = `snapshot-${mode}`;
    await prisma.auditLog.create({ data: { actorName: 'Snapshot', action: 'organization.snapshot.test', resourceType: 'organization', resourceId: roleOrg.id, searchText: marker } });
    let listReady; let resume; let transactionOptions;
    const ready = new Promise((resolve) => { listReady = resolve; });
    const gate = new Promise((resolve) => { resume = resolve; });
    const hookedPrisma = { $transaction: (callback, options) => {
      transactionOptions = options;
      return prisma.$transaction((tx) => callback({
        organizationMember: tx.organizationMember,
        auditLog: {
          findMany: async (args) => { const items = await tx.auditLog.findMany(args); listReady(); await gate; return items; },
          count: async (args) => { await gate; return tx.auditLog.count(args); },
        },
      }), mode === 'read-committed-control' ? { ...options, isolationLevel: 'ReadCommitted' } : options);
    } };
    const reader = mode === 'platform' ? new AuditService(hookedPrisma) : new EnterprisePolicyService(hookedPrisma, {});
    const pending = mode === 'platform' ? reader.search({ q: marker }) : reader.organizationAudit(roleOrg.id, remainingOwner.userId, { q: marker });
    let timeout;
    try {
      await Promise.race([ready, pending.then(() => { throw new Error('snapshot test completed before gate'); }), new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('snapshot test list did not complete')), 3000); })]);
      await admin.query('INSERT INTO "AuditLog" ("id", "actorName", "action", "resourceType", "resourceId", "searchText") VALUES ($1, $2, $3, $4, $5, $6)', [crypto.randomUUID(), 'Concurrent', 'organization.snapshot.test', 'organization', roleOrg.id, marker]);
    } finally { clearTimeout(timeout); resume(); }
    const snapshot = await pending;
    assert.equal(transactionOptions.isolationLevel, 'RepeatableRead');
    assert.equal(snapshot.items.length, 1); assert.equal(snapshot.total, mode === 'read-committed-control' ? 2 : 1);
    const refreshed = mode === 'platform' ? await auditService.search({ q: marker }) : await service.organizationAudit(roleOrg.id, remainingOwner.userId, { q: marker });
    assert.equal(refreshed.items.length, 2); assert.equal(refreshed.total, 2);
  }
});
