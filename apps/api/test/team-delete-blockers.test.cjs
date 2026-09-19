const test = require('node:test');
const assert = require('node:assert/strict');
const { TeamService } = require('../dist/team/team.service.js');

test('team deletion reports active resources but excludes queued cleanup projects', async () => {
  const prisma = {
    $transaction: async (callback) => callback(prisma),
    team: { findUnique: async () => ({ id: 'team-1' }), delete: async () => { throw new Error('must not delete'); } },
    project: { findMany: async () => [{ id: 'project-1', name: 'Active project', status: 'active' }] },
    datasource: { findMany: async () => [{ id: 'source-1', name: 'Database' }] },
    deployTarget: { findMany: async () => [] },
    requirement: { findMany: async () => [] },
    knowledgeFolder: { findMany: async () => [] },
    knowledgeDocument: { findMany: async () => [] },
  };
  const service = new TeamService(prisma);
  await assert.rejects(service.deleteTeam('team-1'), (error) => {
    const body = error.getResponse();
    assert.equal(body.code, 'TEAM_DELETE_BLOCKED');
    assert.deepEqual(body.blockers, { projects: 1, datasources: 1, deployTargets: 0, requirements: 0, knowledgeFolders: 0, knowledgeDocuments: 0 });
    assert.equal(body.blockerDetails.projects[0].status, 'active');
    return true;
  });
});

test('team deletion detaches failed cleanup projects and leaves cleanup task intact', async () => {
  let detached;
  let deleted = false;
  const deletedFolders = [];
  const prisma = {
    $transaction: async (callback) => callback(prisma),
    team: {
      findUnique: async () => ({ id: 'team-1' }),
      delete: async () => { deleted = true; },
    },
    project: {
      findMany: async ({ where }) => {
        assert.deepEqual(where.status.notIn, ['deleting', 'deleting_cleanup', 'deletion_failed']);
        return [];
      },
      updateMany: async (args) => { detached = args; return { count: 1 }; },
    },
    datasource: { findMany: async () => [] },
    deployTarget: { findMany: async () => [] },
    requirement: { findMany: async () => [] },
    knowledgeFolder: {
      findMany: async () => [
        { id: 'parent', name: 'Parent', parentId: null },
        { id: 'child', name: 'Empty child', parentId: 'parent' },
      ],
      deleteMany: async ({ where }) => { deletedFolders.push(where.id.in); },
    },
    knowledgeDocument: { findMany: async () => [] },
  };
  const service = new TeamService(prisma);
  assert.deepEqual(await service.deleteTeam('team-1'), { success: true });
  assert.deepEqual(detached.where.status.in, ['deleting', 'deleting_cleanup', 'deletion_failed']);
  assert.deepEqual(detached.data, { teamId: null });
  assert.deepEqual(deletedFolders, [['child'], ['parent']]);
  assert.equal(deleted, true);
});

test('team card count separates pending cleanup projects', async () => {
  const prisma = {
    $transaction: async (queries) => Promise.all(queries),
    team: {
      findMany: async () => [{ id: 'team-1', _count: { projects: 4 } }],
      count: async () => 1,
    },
    project: { groupBy: async () => [{ teamId: 'team-1', _count: { _all: 3 } }] },
  };
  const service = new TeamService(prisma);
  const result = await service.listTeams({ page: 1, pageSize: 20 });
  assert.deepEqual(result.items[0].projectCounts, { visible: 1, cleanup: 3 });
});
