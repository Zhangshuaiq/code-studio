const test = require('node:test');
const assert = require('node:assert/strict');
const { ProjectService } = require('../dist/project/project.service.js');

test('keep-local recovery only activates failed import with existing code', async () => {
  const project = { id: 'p', userId: 'u', status: 'import_failed', storageKey: 'primary', storagePath: 'p', volumePath: '' };
  let activated = false;
  const prisma = {
    project: {
      findFirst: async () => project,
      updateMany: async () => { activated = true; return { count: 1 }; },
    },
  };
  const access = { isPlatformAdmin: async () => false };
  const workspaces = { existingProjectPath: async () => '/safe/project' };
  const git = { hasWorkspaceCode: async () => true };
  const service = new ProjectService(prisma, access, workspaces, git, {}, {});
  assert.deepEqual(await service.keepLocalAfterImportFailure('u', 'p'), { id: 'p', status: 'active' });
  assert.equal(activated, true);
  activated = false;
  git.hasWorkspaceCode = async () => false;
  await assert.rejects(service.keepLocalAfterImportFailure('u', 'p'), /未发现可保留的本地代码/);
  assert.equal(activated, false);
});
