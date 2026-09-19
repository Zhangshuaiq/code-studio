const test = require('node:test');
const assert = require('node:assert/strict');
const { ProjectAccessService } = require('../dist/project-access/project-access.service.js');
const { ProjectService } = require('../dist/project/project.service.js');

test('platform admin can manage a project without being its creator or member', async () => {
  const prisma = {
    user: { count: async ({ where }) => where.id === 'admin-id' ? 1 : 0 },
    project: { findUnique: async () => ({ id: 'project-1', userId: 'owner-id', status: 'active', members: [] }) },
  };
  const access = new ProjectAccessService(prisma);
  assert.equal((await access.requireProject('admin-id', 'project-1', 'manage')).accessRole, 'owner');
  assert.deepEqual(access.visibleWhere('admin-id', true), {});
  await assert.rejects(access.requireProject('ordinary-id', 'project-1', 'manage'), /项目不存在或无权访问/);
});

test('project deletion permits platform admin and still rejects an unrelated user', async () => {
  let updated = false;
  const prisma = {
    project: {
      findFirst: async ({ where }) => where.userId ? null : ({ id: 'project-1', status: 'active', volumePath: '' }),
      update: async () => { updated = true; },
    },
  };
  const access = { isPlatformAdmin: async (userId) => userId === 'admin-id' };
  const service = new ProjectService(prisma, access, {}, {}, {}, {});
  await assert.rejects(service.remove('ordinary-id', 'project-1'), /项目不存在/);
  assert.equal(updated, false);
  const result = await service.remove('admin-id', 'project-1');
  assert.equal(result.status, 'deleting');
  assert.equal(updated, true);
});

test('admin project list includes projects owned by other users with management controls', async () => {
  let listWhere;
  const prisma = {
    project: {
      findMany: async ({ where }) => {
        listWhere = where;
        return [{ id: 'project-1', userId: 'owner-id', status: 'active', members: [] }];
      },
      count: async () => 1,
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const access = new ProjectAccessService({ user: { count: async () => 1 } });
  const service = new ProjectService(prisma, access, {}, {}, {}, {});
  const page = await service.findAll('admin-id', { page: 1, pageSize: 20 });
  assert.equal(page.items[0].accessRole, 'owner');
  assert.equal(listWhere.OR, undefined);
});
