const test = require('node:test'); const assert = require('node:assert/strict');
const { Reflector } = require('@nestjs/core');
const { of, throwError, lastValueFrom } = require('rxjs');
const { AuditInterceptor } = require('../dist/audit/audit.interceptor.js');
const { AUDIT_KEY } = require('../dist/audit/audit.decorator.js');
const { EnterprisePolicyController, EnterprisePolicyAdminController } = require('../dist/enterprise-policy/enterprise-policy.controller.js');
const { EnterprisePolicyService } = require('../dist/enterprise-policy/enterprise-policy.service.js');
const { AuditService } = require('../dist/audit/audit.service.js');

test('platform audit list/count share a snapshot and timestamp ties have stable ID ordering', async () => {
  let list;
  const tx = { auditLog: {
    findMany: async (args) => { list = args; return [{ id: 'entry' }]; },
    count: async ({ where }) => { assert.deepEqual(where, list.where); return 1; },
  } };
  const service = new AuditService({ $transaction: async (callback, options) => { assert.equal(options.isolationLevel, 'RepeatableRead'); return callback(tx); } });
  const page = await service.search({ q: 'role', page: 2, pageSize: 5 });
  assert.equal(page.total, 1); assert.equal(list.skip, 5); assert.equal(list.take, 5);
  assert.deepEqual(list.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
});

test('organization audit fixes tenant scope and checks current active manager or auditor before reading', async () => {
  const reads = [];
  const prisma = {
    organizationMember: { findUnique: async ({ where }) => {
      const { organizationId, userId } = where.organizationId_userId;
      if (organizationId !== 'own-org' || userId === 'outsider') return null;
      return { role: ['owner', 'disabled'].includes(userId) ? 'owner' : userId === 'admin' ? 'admin' : userId.includes('auditor') ? 'auditor' : 'member', status: userId.startsWith('disabled') ? 'disabled' : 'active' };
    } },
    auditLog: { findMany: async (args) => { reads.push(args); return []; }, count: async ({ where }) => { assert.deepEqual(where, reads.at(-1).where); return 42; } },
    $transaction: async (callback, options) => { assert.equal(options?.isolationLevel, 'RepeatableRead'); return callback(prisma); },
  };
  const service = new EnterprisePolicyService(prisma, {});
  const result = await service.organizationAudit('own-org', 'owner', { resourceId: 'foreign-org', resourceType: 'user', actor: 'Alice', q: 'role', result: 'failure', from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z', page: 2, pageSize: 5 });
  assert.equal(result.total, 42); assert.equal(reads[0].skip, 5); assert.equal(reads[0].take, 5);
  assert.deepEqual(reads[0].where, { resourceType: 'organization', resourceId: 'own-org', action: { startsWith: 'organization.' }, searchText: { contains: 'role', mode: 'insensitive' }, OR: [{ actorName: { contains: 'Alice', mode: 'insensitive' } }, { actorId: 'Alice' }], result: 'failure', createdAt: { gte: new Date('2026-01-01T00:00:00Z'), lte: new Date('2026-12-31T00:00:00Z') } });
  assert.deepEqual(reads[0].orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  for (const field of ['ip', 'path', 'searchText']) assert.equal(reads[0].select[field], undefined);
  await service.organizationAudit('own-org', 'admin', { action: 'organization.invitation.create' });
  assert.equal(reads[1].where.action, 'organization.invitation.create');
  await service.organizationAudit('own-org', 'auditor');
  for (const actor of ['member', 'disabled', 'disabled-auditor', 'outsider']) await assert.rejects(service.organizationAudit('own-org', actor), (error) => error.status === 403);
  await assert.rejects(service.organizationAudit('foreign-org', 'owner'), (error) => error.status === 403);
  assert.equal(reads.length, 3, 'unauthorized users never query audit rows');
});

function harness(meta, request = {}) {
  const entries = []; const interceptor = new AuditInterceptor({ getAllAndOverride: () => meta }, { record: (entry) => entries.push(entry) });
  const req = { params: { id: 'organization-id', userId: 'employee-id', invitationId: 'invitation-id' }, body: { token: 'request-secret', email: 'private@example.com' }, user: { id: 'actor-id', username: 'Manager' }, originalUrl: '/control/enterprise/organizations/organization-id/invitations?token=query-secret', method: 'POST', ip: '127.0.0.1', headers: { 'x-forwarded-for': 'forged-ip' }, ...request };
  const context = { getHandler: () => {}, getClass: () => {}, switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ statusCode: 201 }) }) };
  return { entries, run: (observable) => lastValueFrom(interceptor.intercept(context, { handle: () => observable })) };
}
test('all organization mutations have secret-safe audit metadata and targeted identifiers', () => {
  const reflector = new Reflector();
  const expected = [
    [EnterprisePolicyController, ['acceptInvitation', 'changeRole', 'removeManagedMember', 'inviteMember', 'revokeManagedInvitation', 'createManagedDomain', 'verifyManagedDomain', 'removeManagedDomain', 'updateManagedPolicy']],
    [EnterprisePolicyAdminController, ['create', 'addMember', 'removeMember', 'changeRole', 'createDomain', 'verifyDomain', 'removeDomain', 'invite', 'revokeInvitation', 'updatePolicy']],
  ];
  for (const [controller, methods] of expected) for (const name of methods) {
    const meta = reflector.get(AUDIT_KEY, controller.prototype[name]);
    assert.ok(meta, `${controller.name}.${name} is missing audit metadata`); assert.equal(meta.includeBody, false); assert.equal(meta.resourceType, 'organization'); assert.match(meta.action, /^organization\./);
    assert.equal(meta.transactionalSuccess, true, `${controller.name}.${name} must record atomic success`);
  }
  assert.deepEqual(reflector.get(AUDIT_KEY, EnterprisePolicyController.prototype.changeRole).targetParams, ['userId']);
  assert.deepEqual(reflector.get(AUDIT_KEY, EnterprisePolicyController.prototype.revokeManagedInvitation).targetParams, ['invitationId']);
});
test('organization audit records actor and targets without request, response or query secrets', async () => {
  const { entries, run } = harness({ action: 'organization.invitation.revoke', resourceType: 'organization', includeBody: false, targetParams: ['invitationId'] });
  const response = { id: 'invitation-id', token: 'response-secret' }; assert.deepEqual(await run(of(response)), response);
  assert.equal(entries.length, 1); assert.equal(entries[0].actorId, 'actor-id'); assert.equal(entries[0].resourceId, 'organization-id'); assert.equal(entries[0].result, 'success');
  assert.equal(entries[0].ip, '127.0.0.1');
  assert.deepEqual(entries[0].detail, { body: { bodyOmitted: true }, targets: { invitationId: 'invitation-id' } });
  assert.ok(!/request-secret|response-secret|query-secret|private@example/.test(JSON.stringify(entries)));
  const accepted = harness({ action: 'organization.invitation.accept', resourceType: 'organization', includeBody: false }, { params: {} });
  await accepted.run(of({ organization: { id: 'accepted-org' }, membership: { userId: 'employee' } })); assert.equal(accepted.entries[0].resourceId, 'accepted-org');
  const selected = harness({ action: 'organization.invitation.create', resourceType: 'organization', includeBody: false, resultFields: { invitationId: 'id', role: 'role' } });
  await selected.run(of({ id: 'new-invitation', role: 'member', token: 'never-record', email: 'never@record.test' }));
  assert.deepEqual(selected.entries[0].detail.outcome, { invitationId: 'new-invitation', role: 'member' });
  assert.ok(!JSON.stringify(selected.entries).includes('never-record')); assert.ok(!JSON.stringify(selected.entries).includes('never@record.test'));
});
test('sensitive failures are audited without an exception echo, and deep redaction never returns raw nested input', async () => {
  const sensitive = harness({ action: 'organization.invitation.accept', includeBody: false });
  const error = Object.assign(new Error('invalid token=echoed-secret'), { status: 403 });
  await assert.rejects(sensitive.run(throwError(() => error)), /echoed-secret/);
  assert.equal(sensitive.entries[0].result, 'failure'); assert.equal(sensitive.entries[0].statusCode, 403); assert.ok(!JSON.stringify(sensitive.entries).includes('echoed-secret'));
  const nested = harness({ action: 'legacy.action', includeBody: true }, { body: { password: 'shallow-secret', a: { b: { c: { d: { e: { token: 'deep-secret' } } } } } } });
  await nested.run(of({ success: true })); const serialized = JSON.stringify(nested.entries);
  assert.ok(!serialized.includes('shallow-secret')); assert.ok(!serialized.includes('deep-secret')); assert.ok(serialized.includes('[truncated]'));
});
test('transactional success is not duplicated but failed transactions retain failure audit', async () => {
  const context = harness({ action: 'organization.member.role.update', resourceType: 'organization', includeBody: false, transactionalSuccess: true });
  assert.deepEqual(await context.run(of({ role: 'admin' })), { role: 'admin' }); assert.equal(context.entries.length, 0);
  await assert.rejects(context.run(throwError(() => Object.assign(new Error('database secret'), { status: 500 }))));
  assert.equal(context.entries.length, 1); assert.equal(context.entries[0].result, 'failure');
  assert.ok(!JSON.stringify(context.entries).includes('database secret'));
});
test('member mutations have transactional-success metadata on both administrative surfaces', () => {
  const reflector = new Reflector();
  for (const [controller, names] of [[EnterprisePolicyController, ['changeRole', 'removeManagedMember']], [EnterprisePolicyAdminController, ['addMember', 'changeRole', 'removeMember']]])
    for (const name of names) assert.equal(reflector.get(AUDIT_KEY, controller.prototype[name]).transactionalSuccess, true);
});
test('transactional actor context strips query secrets and ignores forged proxy headers', () => {
  const { auditActorContext } = require('../dist/audit/audit.service.js');
  const req = { user: { id: 'validated-user', username: 'Owner' }, ip: '127.0.0.1', headers: { 'x-forwarded-for': 'forged' }, method: 'PUT', originalUrl: '/control/enterprise/organizations/org/members/user/role?token=secret', body: { actorId: 'forged' } };
  assert.deepEqual(auditActorContext(req), { actorId: 'validated-user', actorName: 'Owner', ip: '127.0.0.1', method: 'PUT', path: '/control/enterprise/organizations/org/members/user/role' });
});
test('both policy routes request atomic success audit and keep platform identity distinct from owner checks', async () => {
  const reflector = new Reflector(); let args;
  for (const [controller, method] of [[EnterprisePolicyController, 'updateManagedPolicy'], [EnterprisePolicyAdminController, 'updatePolicy']])
    assert.equal(reflector.get(AUDIT_KEY, controller.prototype[method]).transactionalSuccess, true);
  const user = { id: 'platform', username: 'Platform' }; const request = { ip: '127.0.0.1', method: 'PUT', originalUrl: '/admin/organizations/org/policy?secret=hidden' };
  const body = { terminalEnabled: true }; const controller = new EnterprisePolicyAdminController({ updatePolicy: async (...input) => { args = input; return body; } });
  assert.equal(await controller.updatePolicy(user, 'org', body, request), body);
  assert.deepEqual(args.slice(0, 4), ['org', body, undefined, undefined]);
  assert.equal(args[4].actorId, 'platform'); assert.equal(args[4].path, '/admin/organizations/org/policy');
});
test('invitation routes require transactional success audit and carry verified identity separately from authorization', async () => {
  const reflector = new Reflector();
  for (const [controller, methods] of [[EnterprisePolicyController, ['acceptInvitation', 'inviteMember', 'revokeManagedInvitation']], [EnterprisePolicyAdminController, ['invite', 'revokeInvitation']]])
    for (const method of methods) assert.equal(reflector.get(AUDIT_KEY, controller.prototype[method]).transactionalSuccess, true);
  const calls = []; const controller = new EnterprisePolicyAdminController({ createInvitation: async (...args) => calls.push(args), revokeInvitation: async (...args) => calls.push(args) });
  const user = { id: 'platform', username: 'Platform' }; const request = { method: 'POST', ip: '127.0.0.1', originalUrl: '/admin/organizations/org/invitations?token=hidden' };
  await controller.invite(user, 'org', { email: 'private@example.com' }, request);
  await controller.revokeInvitation(user, 'org', 'invitation', request);
  assert.equal(calls[0][3], undefined); assert.equal(calls[0][4].actorId, 'platform');
  assert.equal(calls[1][2], undefined); assert.equal(calls[1][3].actorId, 'platform');
  assert.ok(!JSON.stringify(calls.map(row => row.at(-1))).includes('hidden'));
});
test('platform organization and domain writes retain authenticated actor without organization-member checks', async () => {
  const calls = [];
  const controller = new EnterprisePolicyAdminController({ createOrganization: async (...args) => calls.push(['organization', ...args]), createDomain: async (...args) => calls.push(['create', ...args]), verifyDomain: async (...args) => calls.push(['verify', ...args]), removeDomain: async (...args) => calls.push(['remove', ...args]) });
  const user = { id: 'platform', username: 'Platform' }; const request = { method: 'POST', ip: '127.0.0.1', originalUrl: '/admin/organizations?token=hidden' };
  await controller.create(user, { name: 'Example', slug: 'example' }, request);
  await controller.createDomain(user, 'org', { domain: 'example.com' }, request);
  await controller.verifyDomain(user, 'org', 'domain', request);
  await controller.removeDomain(user, 'org', 'domain', request);
  assert.equal(calls[0][2].actorId, 'platform');
  for (const call of calls.slice(1)) { assert.equal(call[3], undefined); assert.equal(call[4].actorId, 'platform'); }
  assert.ok(!JSON.stringify(calls.map(call => call.at(-1))).includes('hidden'));
});
test('platform member routes pass audit identity without requiring organization membership', async () => {
  let args;
  const controller = new EnterprisePolicyAdminController({ updateMemberRole: async (...input) => { args = input; return { role: 'admin' }; } });
  const request = Object.create({ get ip() { return '127.0.0.1'; } });
  Object.assign(request, { method: 'PUT', originalUrl: '/admin/organizations/org/members/employee/role?token=secret', socket: { remoteAddress: 'fallback' } });
  await controller.changeRole({ id: 'platform-id', username: 'Platform' }, 'org', 'employee', { role: 'admin', actorId: 'forged' }, request);
  assert.deepEqual(args.slice(0, 4), ['org', 'employee', 'admin', undefined]);
  assert.deepEqual(args[4], { actorId: 'platform-id', actorName: 'Platform', ip: '127.0.0.1', method: 'PUT', path: '/admin/organizations/org/members/employee/role' });
});
