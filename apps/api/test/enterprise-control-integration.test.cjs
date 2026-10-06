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
  await admin.query('CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "email" TEXT UNIQUE)');
  for (const migration of ['20260925210000_enterprise_policy_control', '20261006100000_organization_invitations', '20261006110000_organization_domains']) {
    await admin.query(fs.readFileSync(path.join(__dirname, '../prisma/migrations', migration, 'migration.sql'), 'utf8'));
  }
  const url = new URL(databaseUrl); url.searchParams.set('schema', schema);
  prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const service = new EnterprisePolicyService(prisma, { get: (_key, fallback) => fallback });
  const org = await service.createOrganization({ name: 'Concurrent Seats', slug: 'seats', seatLimit: 2 });
  const users = ['first', 'second', 'third'].map((id) => ({ id, email: `${id}@company.com` }));
  for (const user of users) await admin.query('INSERT INTO "User" ("id", "email") VALUES ($1, $2)', [user.id, user.email]);
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
});
