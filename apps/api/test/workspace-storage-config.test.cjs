const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceStorageConfigController } = require('../dist/workspace/workspace-storage-config.controller.js');

test('storage target is persisted but active roots remain unchanged until migration', async () => {
  let row = null;
  const prisma = {
    systemSetting: {
      findUnique: async () => row,
      upsert: async ({ create, update }) => { row = { value: row ? update.value : create.value, updatedAt: new Date() }; },
    },
    project: { findMany: async () => [], count: async () => 2 },
  };
  const storage = { projectsRoot: '/mounted/projects', workspacesRoot: '/mounted/workspaces' };
  const controller = new WorkspaceStorageConfigController(prisma, storage);
  const result = await controller.save({ host: 'storage-1', projectsRoot: '/new/projects', workspacesRoot: '/new/workspaces' }, { id: 'admin' });
  assert.equal(result.active.projectsRoot, '/mounted/projects');
  assert.equal(result.target.projectsRoot, '/new/projects');
  assert.equal(result.totalProjects, 2);
  await assert.rejects(controller.save({ host: 'storage-1', projectsRoot: '/', workspacesRoot: '/new/workspaces' }, { id: 'admin' }), /不能使用根目录/);
});
