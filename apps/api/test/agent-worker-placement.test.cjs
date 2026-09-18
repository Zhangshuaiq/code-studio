const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { AgentRuntimeStateService } = require('../dist/agent/agent-runtime-state.service.js');
const { AgentWorkerService } = require('../dist/agent/agent-worker.service.js');

test('CLI state remains at the same shared path across worker instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codegen-agent-state-'));
  try {
    const config = { get: (key, fallback) => key === 'AGENT_STATE_ROOT' ? root : fallback };
    const first = new AgentRuntimeStateService(config);
    const second = new AgentRuntimeStateService(config);
    assert.equal(await first.home('user-1', 'codex'), await second.home('user-1', 'codex'));
    assert.notEqual(await first.home('user-1', 'codex'), await second.home('user-2', 'codex'));
    assert.notEqual(await first.home('user-1', 'codex'), await second.home('user-1', 'claude'));
    await assert.rejects(first.home('../escape', 'codex'), /用户标识/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('general worker delegates coding queue to dedicated agent worker', async () => {
  const config = { get: (key, fallback) => ({ AGENT_WORKER_DEDICATED: 'true', PROCESS_ROLE: 'worker' })[key] ?? fallback };
  const worker = new AgentWorkerService(config, {}, {}, {}, {}, {});
  await worker.onModuleInit();
  assert.deepEqual(await worker.health(), { available: true, status: 'delegated', redisMode: 'standalone' });
  await worker.onModuleDestroy();
});

test('new agent replica does not rewrite tasks owned by another replica', async () => {
  const queries = [];
  const updates = [];
  const prisma = {
    task: {
      findMany: async (query) => { queries.push(query); return [{ id: 'queued-1', status: 'queued' }]; },
      updateMany: async (update) => { updates.push(update); },
    },
  };
  const worker = new AgentWorkerService({ get: (_, fallback) => fallback }, prisma, {}, {}, {}, {});
  worker.queue = { getJob: async () => null };
  await worker.reconcileInterruptedTasks();
  assert.equal(queries[0].where.status, 'queued');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].where, { id: 'queued-1', status: 'queued' });
});
