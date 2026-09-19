const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminService } = require('../dist/admin/admin.service.js');

function setup({ missing = true, previews = 0, deployments = 0 } = {}) {
  let deleted = false;
  let stopped = false;
  const prisma = {
    project: {
      findUnique: async () => ({ id: 'project-1', status: 'deletion_failed' }),
      deleteMany: async () => { deleted = true; return { count: 1 }; },
    },
    previewInstance: { count: async () => previews },
    deployment: { count: async () => deployments },
  };
  const service = new AdminService(prisma, { projectFilesMissing: async () => missing }, { stopProjectForCleanup: async () => { stopped = true; } });
  return { service, wasDeleted: () => deleted, wasStopped: () => stopped };
}

test('missing-files cleanup removes project metadata and cascading associations', async () => {
  const { service, wasDeleted } = setup();
  assert.deepEqual(await service.purgeMissingProject('project-1'), { ok: true, removedProjectId: 'project-1' });
  assert.equal(wasDeleted(), true);
});

test('missing-files cleanup refuses existing files or active previews', async () => {
  for (const options of [{ missing: false }, { previews: 1 }]) {
    const { service, wasDeleted } = setup(options);
    await assert.rejects(service.purgeMissingProject('project-1'));
    assert.equal(wasDeleted(), false);
  }
});

test('missing-files cleanup stops a running deployment before removing records', async () => {
  const { service, wasDeleted, wasStopped } = setup({ deployments: 1 });
  await service.purgeMissingProject('project-1');
  assert.equal(wasStopped(), true);
  assert.equal(wasDeleted(), true);
});
