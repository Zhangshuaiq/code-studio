const test = require('node:test');
const assert = require('node:assert/strict');
const { DatasourceService } = require('../dist/datasource/datasource.service.js');

test('admin datasource list includes records without membership while ordinary users stay scoped', async () => {
  const whereSeen = [];
  const prisma = {
    user: { count: async ({ where }) => where.id === 'admin' ? 1 : 0 },
    datasource: {
      findMany: async ({ where }) => { whereSeen.push(where); return []; },
      count: async () => 0,
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new DatasourceService(prisma, {});
  await service.listDatasources('admin', { page: 1, pageSize: 20 });
  await service.listDatasources('ordinary', { page: 1, pageSize: 20 });
  assert.equal(whereSeen[0].members, undefined);
  assert.deepEqual(whereSeen[1].members, { some: { userId: 'ordinary' } });
});

test('admin can delete an unassigned datasource', async () => {
  let deleted = false;
  const prisma = {
    user: { count: async () => 1 },
    datasource: {
      findFirst: async ({ where }) => {
        assert.equal(where.members, undefined);
        return { id: 'source-1', encryptedConfig: 'encrypted', team: { members: [] }, members: [], approvers: [] };
      },
      delete: async () => { deleted = true; },
    },
  };
  const service = new DatasourceService(prisma, { decrypt: () => '{}' });
  await service.deleteDatasource('source-1', 'admin');
  assert.equal(deleted, true);
});
