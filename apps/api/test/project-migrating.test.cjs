const test = require('node:test');
const assert = require('node:assert/strict');
const { ProjectAccessService } = require('../dist/project-access/project-access.service.js');
const { SessionService } = require('../dist/session/session.service.js');

test('migrating project remains readable but rejects edit and management', async () => {
  const project = { id: 'p', userId: 'u', status: 'migrating', members: [] };
  const prisma = {
    project: { findUnique: async () => project },
    session: { findFirst: async () => ({ id: 's', userId: 'u', project, user: {} }) },
  };
  const access = new ProjectAccessService(prisma);
  assert.equal((await access.requireProject('u', 'p', 'read')).status, 'migrating');
  assert.equal((await access.requireSession('u', 's', 'read')).project.status, 'migrating');
  for (const capability of ['edit', 'manage']) {
    await assert.rejects(access.requireProject('u', 'p', capability), (error) => error.getResponse().code === 'PROJECT_MIGRATING');
    await assert.rejects(access.requireSession('u', 's', capability), (error) => error.getResponse().code === 'PROJECT_MIGRATING');
  }
});

test('migrating project reuses existing session without creating a workspace', async () => {
  let workspaceCalls = 0;
  const existing = { id: 's', userId: 'u', workspacePath: null };
  const prisma = { session: { findUnique: async () => existing, create: async () => { throw new Error('must not create'); } } };
  const service = new SessionService(prisma, { requireProject: async () => ({ status: 'migrating' }) }, { ensureForSession: async () => { workspaceCalls++; } }, {});
  assert.equal((await service.create('u', { projectId: 'p' })).id, 's');
  assert.equal(workspaceCalls, 0);
  prisma.session.findUnique = async () => null;
  await assert.rejects(service.create('u', { projectId: 'p' }), (error) => error.getResponse().code === 'PROJECT_MIGRATING');
});
