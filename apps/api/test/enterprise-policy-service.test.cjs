const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { EnterprisePolicyService } = require('../dist/enterprise-policy/enterprise-policy.service.js');
const { evaluatePolicy } = require('../../desktop/src/policy-verifier.cjs');

function fixture({ edition = 'enterprise', seatLimit = 2 } = {}) {
  const keys = crypto.generateKeyPairSync('ed25519'); const members = [];
  const organization = { id: 'org-1', name: 'Example Corp', slug: 'example', seatLimit, createdAt: new Date(), policy: { terminalEnabled: false, allowedModelEngines: ['codex-cli'], allowedConnectorTypes: ['postgres'], allowedGitHosts: ['github.com'], allowedNetworkHosts: ['api.example.com'], minimumClientVersion: '0.1.0', offlineDays: 7 } };
  organization.policy.updatedAt = new Date();
  const prisma = {
    auditLog: { create: async ({ data }) => ({ id: 'audit-fixture', ...data }) },
    organization: { findUnique: async () => organization, findUniqueOrThrow: async () => organization, create: async ({ data }) => ({ id: 'org-1', ...data }) },
    organizationMember: {
      count: async ({ where }) => members.filter((item) => Object.entries(where).every(([key, value]) => item[key] === value)).length,
      findMany: async ({ where }) => members.filter((item) => Object.entries(where).every(([key, value]) => item[key] === value)).map((item) => ({ ...item, organization })),
      findUnique: async ({ where }) => members.find((item) => item.organizationId === where.organizationId_userId.organizationId && item.userId === where.organizationId_userId.userId) || null,
      findFirst: async () => members[0] ? { ...members[0], organization } : null,
      upsert: async ({ create, update }) => { let item = members.find((value) => value.userId === create.userId); if (item) Object.assign(item, update); else { item = { id: `member-${members.length + 1}`, status: 'active', ...create }; members.push(item); } return item; },
      delete: async ({ where }) => { const index = members.findIndex((item) => item.id === where.id); return members.splice(index, 1)[0]; },
      update: async ({ where, data }) => { const item = members.find((item) => item.id === where.id); Object.assign(item, data); return item; },
    },
    enterprisePolicy: { findUnique: async ({ where }) => where.organizationId === organization.id ? organization.policy : null, upsert: async ({ create, update }) => Object.assign(organization.policy, update || create) },
    licenseSubscription: { findUnique: async () => ({ edition, status: 'active', expiresAt: new Date(Date.now() + 86400_000) }) },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  prisma.$executeRaw = async () => 1;
  const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(); const config = { get: (key, fallback) => key === 'POLICY_ED25519_PRIVATE_KEY' ? privateKey : fallback };
  return { service: new EnterprisePolicyService(prisma, config), members, prisma, organization, publicKey: keys.publicKey };
}

test('organization creation audit copies defaults, authenticated identity and whitelisted fields', async () => {
  const { service, prisma } = fixture(); const rows = [];
  prisma.organization.create = async ({ data }) => ({ id: 'created-org', name: data.name, slug: data.slug, seatLimit: data.seatLimit, verifiedDomains: [], policy: { ...structuredClone(data.policy.create), updatedAt: new Date() } });
  prisma.auditLog.create = async ({ data }) => { rows.push(data); return data; };
  const result = await service.createOrganization({ name: ' Example ', slug: 'EXAMPLE', token: 'do-not-record' }, { actorId: 'platform', actorName: 'Platform' });
  assert.equal(rows.length, 1); assert.equal(rows[0].actorId, 'platform'); assert.equal(rows[0].resourceId, 'created-org');
  assert.equal(rows[0].detail.before, null); assert.equal(rows[0].detail.after.name, 'Example'); assert.equal(rows[0].detail.after.slug, 'example'); assert.equal(rows[0].detail.after.seatLimit, 10);
  result.verifiedDomains.push('changed.example.com'); result.policy.allowedModelEngines.push('changed');
  assert.deepEqual(rows[0].detail.after.verifiedDomains, []); assert.ok(!rows[0].detail.after.policy.allowedModelEngines.includes('changed'));
  assert.ok(!JSON.stringify(rows).includes('do-not-record'));
});
test('policy audit copies normalized whitelisted before/after snapshots and excludes input secrets', async () => {
  const { service, prisma, organization } = fixture(); const rows = [];
  prisma.auditLog.create = async ({ data }) => { rows.push(data); return data; };
  organization.policy.secret = 'stored-secret';
  const input = { ...organization.policy, terminalEnabled: true, offlineDays: 2, allowedModelEngines: ['codex-cli', 'codex-cli'], allowedGitHosts: ['LOCAL', 'local'], token: 'request-secret', expectedUpdatedAt: 'dto-extra' };
  const result = await service.updatePolicy('org-1', input, undefined, undefined, { actorId: 'platform', actorName: 'Platform' });
  assert.equal(rows.length, 1); assert.equal(rows[0].actorId, 'platform'); assert.equal(rows[0].resourceId, 'org-1');
  assert.equal(rows[0].detail.before.terminalEnabled, false); assert.equal(rows[0].detail.after.terminalEnabled, true);
  assert.deepEqual(rows[0].detail.after.allowedModelEngines, ['codex-cli']); assert.deepEqual(rows[0].detail.after.allowedGitHosts, ['local']);
  result.allowedModelEngines.push('changed-after-return');
  assert.deepEqual(rows[0].detail.after.allowedModelEngines, ['codex-cli'], 'snapshot must not retain mutable array references');
  assert.ok(!/stored-secret|request-secret|dto-extra/.test(JSON.stringify(rows)));
});
test('enterprise policy is signed for an active organization member and accepted by desktop', async () => {
  const { service, publicKey } = fixture(); await service.addMember('org-1', { userId: '11111111-1111-4111-8111-111111111111', role: 'member' });
  const issued = await service.issueForUser('11111111-1111-4111-8111-111111111111'); const verified = evaluatePolicy(issued.token, { publicKey });
  assert.equal(verified.state, 'active'); assert.equal(verified.organizationId, 'org-1'); assert.equal(verified.policy.terminalEnabled, false); assert.deepEqual(verified.policy.allowedGitHosts, ['github.com']);
});
test('owner policy changes are used by later signed desktop policy, without replacing existing tokens', async () => {
  const { service, publicKey, members } = fixture({ seatLimit: 10 });
  await service.addMember('org-1', { userId: 'owner', role: 'owner' });
  const before = await service.issueForUser('owner'); const policy = await service.managedPolicy('org-1', 'owner');
  await service.updatePolicy('org-1', { ...policy, terminalEnabled: true, allowedGitHosts: ['local'], offlineDays: 2 }, 'owner', policy.updatedAt.toISOString());
  const after = await service.issueForUser('owner');
  assert.equal(evaluatePolicy(before.token, { publicKey }).policy.terminalEnabled, false);
  const verified = evaluatePolicy(after.token, { publicKey }); assert.equal(verified.policy.terminalEnabled, true); assert.deepEqual(verified.policy.allowedGitHosts, ['local']);
  assert.equal(new Date(after.offlineUntil) - new Date(after.expiresAt), 2 * 86400_000);
  members[0].status = 'disabled';
  await assert.rejects(service.managedPolicy('org-1', 'owner'), (error) => error.status === 403);
  await assert.rejects(service.updatePolicy('org-1', policy, 'owner', policy.updatedAt.toISOString()), (error) => error.status === 403);
});

test('organization managers are scoped, cannot escalate privileges, and must preserve the last active owner', async () => {
  const { service, members } = fixture({ seatLimit: 10 });
  await service.addMember('org-1', { userId: 'owner', role: 'owner' });
  await service.addMember('org-1', { userId: 'admin', role: 'admin' });
  await service.addMember('org-1', { userId: 'member', role: 'member' });
  assert.equal((await service.myOrganizations('member')).length, 1);
  assert.equal((await service.managedMembers('org-1', 'owner')).length, 3);
  for (const actor of ['member', 'outsider']) {
    await assert.rejects(service.managedMembers('org-1', actor), (error) => error.response.code === 'ORGANIZATION_MANAGEMENT_FORBIDDEN');
    await assert.rejects(service.updateMemberRole('org-1', 'member', 'owner', actor), (error) => error.response.code === 'ORGANIZATION_MANAGEMENT_FORBIDDEN');
    await assert.rejects(service.removeMember('org-1', 'member', actor), (error) => error.response.code === 'ORGANIZATION_MANAGEMENT_FORBIDDEN');
  }
  await assert.rejects(service.managedMembers('other-org', 'owner'), (error) => error.response.code === 'ORGANIZATION_MANAGEMENT_FORBIDDEN');
  await assert.rejects(service.updateMemberRole('org-1', 'member', 'admin', 'admin'), (error) => error.response.code === 'ORGANIZATION_ROLE_FORBIDDEN');
  await assert.rejects(service.removeMember('org-1', 'owner', 'admin'), (error) => error.response.code === 'ORGANIZATION_ROLE_FORBIDDEN');
  await assert.rejects(service.updateMemberRole('org-1', 'owner', 'member', 'owner'), (error) => error.response.code === 'ORGANIZATION_LAST_OWNER');
  await assert.rejects(service.addMember('org-1', { userId: 'owner', role: 'member' }), (error) => error.response.code === 'ORGANIZATION_LAST_OWNER');
  await assert.rejects(service.removeMember('org-1', 'owner'), (error) => error.response.code === 'ORGANIZATION_LAST_OWNER');
  await service.updateMemberRole('org-1', 'member', 'owner', 'owner');
  await service.updateMemberRole('org-1', 'owner', 'member', 'member');
  await assert.rejects(service.updateMemberRole('org-1', 'admin', 'member', 'owner'), (error) => error.response.code === 'ORGANIZATION_MANAGEMENT_FORBIDDEN');
  await service.removeMember('org-1', 'owner', 'admin');
  members.find((item) => item.userId === 'admin').status = 'disabled';
  await assert.rejects(service.managedMembers('org-1', 'admin'), (error) => error.response.code === 'ORGANIZATION_MANAGEMENT_FORBIDDEN');
});

test('organization HTTP routes authenticate JWT, validate roles and authorize database membership rather than token roles', async (t) => {
  const { Module, ValidationPipe } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { PassportStrategy } = require('@nestjs/passport');
  const { Strategy, ExtractJwt } = require('passport-jwt');
  const { JwtService } = require('@nestjs/jwt');
  const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard.js');
  const { EnterprisePolicyController } = require('../dist/enterprise-policy/enterprise-policy.controller.js');
  const { Reflector } = require('@nestjs/core'); const { AuditInterceptor } = require('../dist/audit/audit.interceptor.js'); const auditEntries = [];
  const { service } = invitationFixture({ seatLimit: 10 });
  service.prisma.auditLog = { create: async ({ data }) => { auditEntries.push(data); return { id: 'audit-fixture', ...data }; }, findMany: async () => [], count: async () => 0 };
  const domainRows = [];
  const domainMatches = (row, where) => Object.entries(where).every(([key, value]) => value && typeof value === 'object' ? 'gt' in value ? row[key] > value.gt : row[key] !== value.not : row[key] === value);
  service.prisma.organizationDomain = {
    findMany: async ({ where }) => domainRows.filter((row) => domainMatches(row, where)),
    findFirst: async ({ where }) => domainRows.find((row) => domainMatches(row, where)) || null,
    findUnique: async ({ where }) => domainRows.find((row) => domainMatches(row, where.organizationId_domain)) || null,
    findUniqueOrThrow: async ({ where }) => { const row = domainRows.find((item) => domainMatches(item, where)); assert.ok(row); return row; },
    count: async ({ where }) => domainRows.filter((row) => domainMatches(row, where)).length,
    upsert: async ({ where, create, update }) => { let row = domainRows.find((item) => domainMatches(item, where.organizationId_domain)); if (row) Object.assign(row, update); else { row = { id: `domain-${domainRows.length}`, verifiedAt: null, createdAt: new Date(), ...create }; domainRows.push(row); } return row; },
    updateMany: async ({ where, data }) => { const rows = domainRows.filter((row) => domainMatches(row, where)); rows.forEach((row) => Object.assign(row, data)); return { count: rows.length }; },
    deleteMany: async ({ where }) => { const index = domainRows.findIndex((row) => domainMatches(row, where)); if (index < 0) return { count: 0 }; domainRows.splice(index, 1); return { count: 1 }; },
  };
  const domainOrganization = await service.prisma.organization.findUnique(); domainOrganization.verifiedDomains = [];
  service.prisma.organization.update = async ({ data }) => Object.assign(domainOrganization, data);
  let dnsReads = 0;
  service.resolveDomainTxt = async (host) => { dnsReads++; return domainRows.filter((row) => host === `_code-studio-verification.${row.domain}`).map((row) => [`code-studio-verification=${row.token}`]); };
  await service.addMember('org-1', { userId: 'owner', role: 'owner' }); await service.addMember('org-1', { userId: 'employee', role: 'member' });
  const secret = crypto.randomBytes(32).toString('hex');
  class TestStrategy extends PassportStrategy(Strategy) {
    constructor() { super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: secret }); }
    validate(payload) { return { id: payload.sub, username: payload.sub, email: payload.email, roles: payload.roles || [], permissions: [] }; }
  }
  class TestModule {}
  Module({ controllers: [EnterprisePolicyController], providers: [JwtAuthGuard, TestStrategy, { provide: EnterprisePolicyService, useValue: service }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalInterceptors(new AuditInterceptor(new Reflector(), { record: (entry) => auditEntries.push(entry) }));
  t.after(() => app.close()); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(); const base = `${origin}/control/enterprise`;
  const jwt = new JwtService({ secret }); const headers = (id, roles = []) => ({ Authorization: `Bearer ${jwt.sign({ sub: id, roles, email: `${id}@example.com` }, { expiresIn: '1m' })}`, 'Content-Type': 'application/json' });
  assert.equal((await fetch(`${base}/organizations`)).status, 401);
  assert.equal((await fetch(`${base}/organizations`, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await fetch(`${base}/organizations`, { headers: headers('owner') })).status, 200);
  assert.equal((await fetch(`${base}/organizations/org-1/members`, { headers: headers('owner') })).status, 200);
  const auditUrl = `${base}/organizations/org-1/audit`;
  assert.equal((await fetch(auditUrl)).status, 401);
  const auditPage = await fetch(`${auditUrl}?page=2&pageSize=5`, { headers: headers('owner') }); assert.equal(auditPage.status, 200); assert.equal((await auditPage.json()).page, 2);
  for (const query of ['pageSize=101', 'page=-1', 'from=invalid', 'action=user.delete', 'resourceId=other-org', 'from=2026-10-09T00:00:00Z&to=2026-10-08T00:00:00Z']) assert.equal((await fetch(`${auditUrl}?${query}`, { headers: headers('owner') })).status, 400);
  assert.equal((await fetch(auditUrl, { headers: headers('employee') })).status, 403);
  assert.equal((await fetch(`${base}/organizations/other-org/audit`, { headers: headers('owner') })).status, 403);
  const domainsUrl = `${base}/organizations/org-1/domains`;
  assert.equal((await fetch(domainsUrl)).status, 401);
  assert.equal((await fetch(domainsUrl, { headers: headers('owner') })).status, 200);
  assert.equal((await fetch(`${base}/organizations/other-org/domains`, { headers: headers('owner') })).status, 403);
  for (const [suffix, method, body] of [['', 'GET'], ['', 'POST', { domain: 'company.com' }], ['/unknown/verify', 'POST'], ['/unknown', 'DELETE']]) {
    assert.equal((await fetch(domainsUrl + suffix, { method, headers: headers('employee', ['admin']), ...(body ? { body: JSON.stringify(body) } : {}) })).status, 403);
  }
  assert.equal((await fetch(`${base}/organizations/org-1/members`, { headers: headers('employee', ['owner', 'admin']) })).status, 403);
  assert.equal((await fetch(`${base}/organizations/other-org/members`, { headers: headers('owner') })).status, 403);
  const change = (role) => fetch(`${base}/organizations/org-1/members/employee/role`, { method: 'PUT', headers: headers('owner'), body: JSON.stringify({ role }) });
  assert.equal((await change('super-admin')).status, 400);
  assert.equal((await change('admin')).status, 200);
  const roleAuditRows = auditEntries.filter(entry => entry.action === 'organization.member.role.update' && entry.result === 'success');
  assert.equal(roleAuditRows.length, 1, 'transactional success must not be recorded twice');
  assert.equal(roleAuditRows[0].actorId, 'owner'); assert.equal(roleAuditRows[0].actorName, 'owner');
  assert.match(roleAuditRows[0].ip, /127\.0\.0\.1/); assert.equal(roleAuditRows[0].method, 'PUT');
  assert.equal(roleAuditRows[0].detail.before.role, 'member'); assert.equal(roleAuditRows[0].detail.after.role, 'admin');
  assert.equal((await fetch(domainsUrl, { headers: headers('employee') })).status, 200);
  const policyUrl = `${base}/organizations/org-1/policy`;
  assert.equal((await fetch(policyUrl)).status, 401);
  const policy = await (await fetch(policyUrl, { headers: headers('employee') })).json(); assert.ok(policy.updatedAt);
  const policyBody = { terminalEnabled: true, allowedModelEngines: ['codex-cli'], allowedConnectorTypes: ['postgres'], allowedGitHosts: ['local'], allowedNetworkHosts: [], minimumClientVersion: '0.1.0', offlineDays: 2, expectedUpdatedAt: policy.updatedAt };
  const putPolicy = (actor, body) => fetch(policyUrl, { method: 'PUT', headers: headers(actor), body: JSON.stringify(body) });
  assert.equal((await putPolicy('employee', policyBody)).status, 403);
  assert.equal((await putPolicy('owner', { ...policyBody, offlineDays: 91 })).status, 400);
  assert.equal((await putPolicy('owner', { ...policyBody, expectedUpdatedAt: undefined })).status, 400);
  const savedPolicy = await putPolicy('owner', policyBody); assert.equal(savedPolicy.status, 200); assert.notEqual((await savedPolicy.json()).updatedAt, policy.updatedAt);
  const policyAuditRows = auditEntries.filter(entry => entry.action === 'organization.policy.update' && entry.result === 'success');
  assert.equal(policyAuditRows.length, 1); assert.equal(policyAuditRows[0].actorId, 'owner');
  assert.equal(policyAuditRows[0].detail.before.terminalEnabled, false); assert.equal(policyAuditRows[0].detail.after.terminalEnabled, true);
  assert.equal(policyAuditRows[0].detail.before.updatedAt, policy.updatedAt); assert.equal(policyAuditRows[0].method, 'PUT');
  assert.equal((await putPolicy('owner', policyBody)).status, 409);
  assert.equal((await fetch(`${base}/organizations/foreign/policy`, { headers: headers('owner') })).status, 403);
  assert.equal((await fetch(domainsUrl, { method: 'POST', headers: headers('owner'), body: JSON.stringify({ domain: 'bad/path' }) })).status, 400);
  const domainResponse = await fetch(domainsUrl, { method: 'POST', headers: headers('employee'), body: JSON.stringify({ domain: 'Managed.Company.com' }) });
  assert.equal(domainResponse.status, 201); const domain = await domainResponse.json();
  assert.equal(domain.domain, 'managed.company.com'); assert.ok(domain.recordValue.startsWith('code-studio-verification='));
  const domainList = await (await fetch(domainsUrl, { headers: headers('owner') })).json(); assert.equal(domainList[0].id, domain.id);
  const dnsBefore = dnsReads;
  assert.equal((await fetch(`${base}/organizations/other-org/domains/${domain.id}/verify`, { method: 'POST', headers: headers('owner') })).status, 403);
  assert.equal(dnsReads, dnsBefore, 'foreign organization request never performs DNS lookup');
  const verifiedDomain = await fetch(`${domainsUrl}/${domain.id}/verify`, { method: 'POST', headers: headers('employee') });
  assert.equal(verifiedDomain.status, 201); assert.ok((await verifiedDomain.json()).verifiedAt);
  const createDomainAudit = auditEntries.filter(row => row.action === 'organization.domain.create' && row.result === 'success');
  const verifyDomainAudit = auditEntries.filter(row => row.action === 'organization.domain.verify' && row.result === 'success');
  assert.equal(createDomainAudit.length, 1); assert.equal(verifyDomainAudit.length, 1); assert.equal(verifyDomainAudit[0].actorId, 'employee');
  assert.equal(verifyDomainAudit[0].detail.before.domain.verifiedAt, null); assert.ok(verifyDomainAudit[0].detail.after.domain.verifiedAt);
  assert.deepEqual(verifyDomainAudit[0].detail.before.verifiedDomains, []); assert.deepEqual(verifyDomainAudit[0].detail.after.verifiedDomains, ['managed.company.com']);
  const dnsAfterVerified = dnsReads;
  assert.equal((await fetch(`${domainsUrl}/${domain.id}/verify`, { method: 'POST', headers: headers('employee') })).status, 201);
  assert.equal(dnsReads, dnsAfterVerified); assert.equal(auditEntries.filter(row => row.action === 'organization.domain.verify' && row.result === 'success').length, 2);
  assert.equal((await fetch(domainsUrl, { method: 'POST', headers: headers('employee'), body: JSON.stringify({ domain: 'managed.company.com' }) })).status, 201);
  assert.equal(auditEntries.filter(row => row.action === 'organization.domain.create' && row.result === 'success').length, 2);
  assert.equal((await fetch(`${domainsUrl}/${domain.id}`, { method: 'DELETE', headers: headers('employee') })).status, 200);
  assert.equal(domainRows.length, 0);
  const removedDomainAudit = auditEntries.filter(row => row.action === 'organization.domain.remove' && row.result === 'success');
  assert.equal(removedDomainAudit.length, 1); assert.equal(removedDomainAudit[0].detail.after.domain, null);
  assert.deepEqual(removedDomainAudit[0].detail.before.verifiedDomains, ['managed.company.com']); assert.deepEqual(removedDomainAudit[0].detail.after.verifiedDomains, []);
  const invitationsUrl = `${base}/organizations/org-1/invitations`;
  assert.equal((await fetch(invitationsUrl)).status, 401);
  assert.equal((await fetch(invitationsUrl, { headers: headers('employee') })).status, 200);
  const elevated = await fetch(invitationsUrl, { method: 'POST', headers: headers('employee'), body: JSON.stringify({ email: 'new@example.com', role: 'admin' }) }); assert.equal(elevated.status, 403);
  const invited = await fetch(invitationsUrl, { method: 'POST', headers: headers('employee'), body: JSON.stringify({ email: 'new@example.com', role: 'member' }) }); assert.equal(invited.status, 201);
  const invitation = await invited.json(); assert.ok(invitation.token); assert.equal(invitation.tokenHash, undefined);
  const createdAudit = auditEntries.filter(row => row.action === 'organization.invitation.create' && row.result === 'success');
  assert.equal(createdAudit.length, 1); assert.equal(createdAudit[0].actorId, 'employee'); assert.equal(createdAudit[0].statusCode, 201);
  assert.equal(createdAudit[0].detail.after.invitations[0].id, invitation.id); assert.equal(createdAudit[0].detail.transactional, true);
  const listed = await (await fetch(invitationsUrl, { headers: headers('owner') })).json(); assert.ok(listed.every((item) => !item.token && !item.tokenHash));
  assert.equal((await fetch(`${invitationsUrl}/${invitation.id}`, { method: 'DELETE', headers: headers('employee') })).status, 200);
  const revokedAudit = auditEntries.filter(row => row.action === 'organization.invitation.revoke' && row.result === 'success');
  assert.equal(revokedAudit.length, 1); assert.equal(revokedAudit[0].detail.before.status, 'pending'); assert.equal(revokedAudit[0].detail.after.status, 'revoked');
  const acceptingInviteResponse = await fetch(invitationsUrl, { method: 'POST', headers: headers('owner'), body: JSON.stringify({ email: 'accepted@example.com' }) });
  assert.equal(acceptingInviteResponse.status, 201); const acceptingInvite = await acceptingInviteResponse.json();
  const acceptUrl = `${base}/invitations/accept`;
  assert.equal((await fetch(acceptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: acceptingInvite.token }) })).status, 401);
  assert.equal((await fetch(acceptUrl, { method: 'POST', headers: headers('employee'), body: JSON.stringify({ token: acceptingInvite.token }) })).status, 403);
  const acceptedResponse = await fetch(acceptUrl, { method: 'POST', headers: headers('accepted'), body: JSON.stringify({ token: acceptingInvite.token }) });
  assert.equal(acceptedResponse.status, 201); assert.equal((await acceptedResponse.json()).membership.userId, 'accepted');
  assert.equal((await fetch(acceptUrl, { method: 'POST', headers: headers('accepted'), body: JSON.stringify({ token: acceptingInvite.token }) })).status, 404);
  const acceptedAudit = auditEntries.filter(row => row.action === 'organization.invitation.accept' && row.result === 'success');
  assert.equal(acceptedAudit.length, 1); assert.equal(acceptedAudit[0].actorId, 'accepted'); assert.equal(acceptedAudit[0].resourceId, 'org-1');
  assert.equal(acceptedAudit[0].detail.before.invitation.status, 'pending'); assert.equal(acceptedAudit[0].detail.after.invitation.status, 'accepted');
  assert.equal(acceptedAudit[0].detail.before.membership, null); assert.equal(acceptedAudit[0].detail.after.membership.userId, 'accepted');
  for (const sensitive of [acceptingInvite.token, 'accepted@example.com', acceptingInvite.tokenHash]) if (sensitive) assert.ok(!JSON.stringify(auditEntries).includes(sensitive));
  assert.equal((await fetch(`${base}/organizations/org-1/members/owner`, { method: 'DELETE', headers: headers('owner') })).status, 403);
  // Downgrade the employee using the service; its existing signed admin claim
  // cannot preserve organization access after the database membership changes.
  await service.updateMemberRole('org-1', 'employee', 'member', 'owner');
  assert.equal((await fetch(`${base}/organizations/org-1/members`, { headers: headers('employee', ['admin']) })).status, 403);
  assert.equal((await fetch(invitationsUrl, { headers: headers('employee', ['admin']) })).status, 403);
  assert.equal((await fetch(domainsUrl, { headers: headers('employee', ['admin']) })).status, 403);
  assert.equal((await fetch(policyUrl, { headers: headers('employee', ['admin']) })).status, 403);
  assert.ok(auditEntries.some((entry) => entry.action === 'organization.member.role.update' && entry.result === 'success' && entry.detail.targets.userId === 'employee'));
  assert.ok(auditEntries.some((entry) => entry.action === 'organization.member.remove' && entry.result === 'failure' && entry.statusCode === 403));
  assert.ok(auditEntries.some((entry) => entry.action === 'organization.invitation.create' && entry.result === 'success'));
  assert.ok(!JSON.stringify(auditEntries).includes(invitation.token));
  for (const action of ['create', 'verify', 'remove']) assert.ok(auditEntries.some((entry) => entry.action === `organization.domain.${action}` && entry.result === 'success'));
  assert.ok(!JSON.stringify(auditEntries).includes(domain.token));
  assert.ok(!JSON.stringify(auditEntries).includes(domain.recordValue));
  assert.ok(auditEntries.some((entry) => entry.action === 'organization.policy.update' && entry.result === 'success'));
  assert.ok(auditEntries.some((entry) => entry.action === 'organization.policy.update' && entry.result === 'failure' && entry.statusCode === 409));
  const grantAuditor = await fetch(`${base}/organizations/org-1/members/accepted/role`, { method: 'PUT', headers: headers('owner'), body: JSON.stringify({ role: 'auditor' }) });
  assert.equal(grantAuditor.status, 200);
  assert.equal((await fetch(auditUrl, { headers: headers('accepted') })).status, 200);
  assert.equal((await fetch(`${base}/organizations/other-org/audit`, { headers: headers('accepted') })).status, 403);
  for (const [path, method, body] of [
    ['/members', 'GET'], ['/invitations', 'GET'], ['/domains', 'GET'], ['/policy', 'GET'],
    ['/members/employee/role', 'PUT', { role: 'owner' }], ['/members/employee', 'DELETE'],
    ['/invitations', 'POST', { email: 'forbidden@example.com', role: 'member' }], ['/invitations/unknown', 'DELETE'],
    ['/domains', 'POST', { domain: 'forbidden.company.com' }], ['/domains/unknown/verify', 'POST'], ['/domains/unknown', 'DELETE'],
    ['/policy', 'PUT', policyBody],
  ]) assert.equal((await fetch(`${base}/organizations/org-1${path}`, { method, headers: headers('accepted', ['owner', 'admin']), ...(body ? { body: JSON.stringify(body) } : {}) })).status, 403, `${method} ${path}`);
  const auditInvitation = await fetch(invitationsUrl, { method: 'POST', headers: headers('owner'), body: JSON.stringify({ email: 'audit-invite@example.com', role: 'auditor' }) });
  assert.equal(auditInvitation.status, 201); const auditInvite = await auditInvitation.json(); assert.equal(auditInvite.role, 'auditor');
  const revokeAuditor = await fetch(`${base}/organizations/org-1/members/accepted/role`, { method: 'PUT', headers: headers('owner'), body: JSON.stringify({ role: 'member' }) });
  assert.equal(revokeAuditor.status, 200); assert.equal((await fetch(auditUrl, { headers: headers('accepted', ['auditor']) })).status, 403);
});

function invitationFixture(options) {
  const fixtureValue = fixture(options); const rows = [];
  fixtureValue.prisma.user = { findFirst: async () => null };
  const matches = (row, where) => Object.entries(where).every(([key, value]) => {
    if (key === 'expiresAt') return row.expiresAt > value.gt;
    if (key === 'email' && typeof value === 'object') return row.email !== value.not;
    if (value && typeof value === 'object' && 'not' in value) return row[key] !== value.not;
    return row[key] === value;
  });
  fixtureValue.prisma.organizationInvitation = {
    count: async ({ where }) => rows.filter((row) => matches(row, where)).length,
    create: async ({ data }) => { const row = { id: `invite-${rows.length}`, status: 'pending', createdAt: new Date(), ...data }; rows.push(row); return row; },
    findMany: async ({ where }) => rows.filter((row) => matches(row, where)),
    findFirst: async ({ where }) => rows.find((row) => matches(row, where)) || null,
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

test('organization invitations enforce owner/admin roles including replacement and revocation paths', async () => {
  const { service, members, rows } = invitationFixture({ seatLimit: 10 });
  await service.addMember('org-1', { userId: 'owner', role: 'owner' }); await service.addMember('org-1', { userId: 'admin', role: 'admin' }); await service.addMember('org-1', { userId: 'member' });
  const forbidden = (code) => (error) => error.response.code === code;
  for (const actor of ['member', 'outsider']) {
    await assert.rejects(service.invitations('org-1', actor), forbidden('ORGANIZATION_MANAGEMENT_FORBIDDEN'));
    await assert.rejects(service.createInvitation('org-1', actor, { email: 'new@example.com' }, actor), forbidden('ORGANIZATION_MANAGEMENT_FORBIDDEN'));
    await assert.rejects(service.revokeInvitation('org-1', 'missing', actor), forbidden('ORGANIZATION_MANAGEMENT_FORBIDDEN'));
  }
  await assert.rejects(service.createInvitation('other-org', 'owner', { email: 'new@example.com' }, 'owner'), forbidden('ORGANIZATION_MANAGEMENT_FORBIDDEN'));
  await assert.rejects(service.createInvitation('org-1', 'admin', { email: 'new@example.com', role: 'admin' }, 'admin'), forbidden('ORGANIZATION_ROLE_FORBIDDEN'));
  const management = await service.createInvitation('org-1', 'owner', { email: 'leader@example.com', role: 'admin' }, 'owner');
  const auditInvitation = await service.createInvitation('org-1', 'owner', { email: 'audit@example.com', role: 'auditor' }, 'owner');
  await assert.rejects(service.createInvitation('org-1', 'admin', { email: 'other-audit@example.com', role: 'auditor' }, 'admin'), forbidden('ORGANIZATION_ROLE_FORBIDDEN'));
  await assert.rejects(service.createInvitation('org-1', 'admin', { email: auditInvitation.email, role: 'member' }, 'admin'), forbidden('ORGANIZATION_ROLE_FORBIDDEN'));
  await assert.rejects(service.revokeInvitation('org-1', auditInvitation.id, 'admin'), forbidden('ORGANIZATION_ROLE_FORBIDDEN'));
  assert.equal(rows.find(row => row.id === auditInvitation.id).status, 'pending');
  await assert.rejects(service.revokeInvitation('org-1', management.id, 'admin'), forbidden('ORGANIZATION_ROLE_FORBIDDEN'));
  await assert.rejects(service.createInvitation('org-1', 'admin', { email: management.email, role: 'member' }, 'admin'), forbidden('ORGANIZATION_ROLE_FORBIDDEN'));
  assert.equal(rows.find((row) => row.id === management.id).status, 'pending');
  const normal = await service.createInvitation('org-1', 'admin', { email: 'new@example.com' }, 'admin');
  assert.ok((await service.invitations('org-1', 'admin')).every((row) => !row.token && !row.tokenHash));
  await service.revokeInvitation('org-1', normal.id, 'admin'); assert.equal(rows.find((row) => row.id === normal.id).status, 'revoked');
  members.find((member) => member.userId === 'admin').status = 'disabled';
  await assert.rejects(service.invitations('org-1', 'admin'), forbidden('ORGANIZATION_MANAGEMENT_FORBIDDEN'));
  await service.revokeInvitation('org-1', management.id, 'owner');
  await service.revokeInvitation('org-1', auditInvitation.id, 'owner');
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

test('invitation audit preserves existing roles and captures reactivation without mutable snapshots or secrets', async () => {
  const { service, prisma, members, rows } = invitationFixture({ seatLimit: 5 }); const entries = [];
  prisma.auditLog.create = async ({ data }) => { entries.push(data); return data; };
  const invite = await service.createInvitation('org-1', 'platform', { email: 'existing@example.com', role: 'member' });
  members.push({ id: 'existing-member', organizationId: 'org-1', userId: 'existing', role: 'admin', status: 'disabled' });
  const result = await service.acceptInvitation({ id: 'existing', username: 'Existing', email: 'Existing@Example.com' }, invite.token, { actorId: 'forged' });
  const entry = entries.find(row => row.action === 'organization.invitation.accept');
  assert.equal(entry.actorId, 'existing'); assert.equal(entry.actorName, 'Existing'); assert.equal(entry.detail.outcome.role, 'admin');
  assert.equal(entry.detail.before.membership.status, 'disabled'); assert.equal(entry.detail.before.membership.role, 'admin');
  assert.equal(entry.detail.after.membership.status, 'active'); assert.equal(entry.detail.after.membership.role, 'admin');
  result.membership.role = 'changed'; rows[0].status = 'changed';
  assert.equal(entry.detail.after.membership.role, 'admin'); assert.equal(entry.detail.after.invitation.status, 'accepted');
  for (const secret of [invite.token, rows[0].tokenHash, 'existing@example.com']) assert.ok(!JSON.stringify(entries).includes(secret));
});
test('organization seat limits and enterprise subscription are enforced', async () => {
  const { service } = fixture({ seatLimit: 1 }); await service.addMember('org-1', { userId: '11111111-1111-4111-8111-111111111111' });
  await assert.rejects(service.addMember('org-1', { userId: '22222222-2222-4222-8222-222222222222' }), (error) => error?.response?.code === 'ORGANIZATION_SEAT_LIMIT');
  const personal = fixture({ edition: 'personal-pro' }); await personal.service.addMember('org-1', { userId: '11111111-1111-4111-8111-111111111111' });
  await assert.rejects(personal.service.issueForUser('11111111-1111-4111-8111-111111111111'), (error) => error?.response?.code === 'ENTERPRISE_LICENSE_REQUIRED');
});
