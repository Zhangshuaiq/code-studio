const test = require('node:test');
const assert = require('node:assert/strict');
const { GenerationExecutorService } = require('../dist/agent/generation-executor.service.js');

test('local coding prepares a project workspace without Kubernetes or Docker', async () => {
  let kubernetesTouched = false;
  const config = { get: (key, fallback) => key === 'GENERATION_EXECUTOR' ? 'local' : fallback };
  const prisma = {
    session: { findUnique: async () => ({ userId: 'user-1', project: { language: 'react-vite' } }) },
  };
  const workspaces = { ensureForSession: async () => ({ path: '/tmp/codegen-local-test' }) };
  const sandbox = { ensureSandbox: async () => { kubernetesTouched = true; } };
  const executor = new GenerationExecutorService(prisma, config, workspaces, sandbox);
  const prepared = await executor.prepare('session-1');
  assert.equal(prepared.volumePath, '/tmp/codegen-local-test');
  assert.equal(prepared.verificationAvailable, false);
  assert.equal(kubernetesTouched, false);
  assert.deepEqual(await executor.health(), { available: true, kind: 'local', verificationAvailable: false });
  await assert.rejects(executor.exec('session-1', ['sh', '-c', 'echo unsafe']), /不执行未经隔离的构建命令/);
});

test('development falls back to coding when the configured cluster is unavailable', async () => {
  const config = { get: (key, fallback) => key === 'GENERATION_EXECUTOR' ? 'kubernetes' : key === 'NODE_ENV' ? 'development' : fallback };
  const prisma = { session: { findUnique: async () => ({ userId: 'user-1', project: { language: 'react-vite' } }) } };
  const workspaces = { ensureForSession: async () => ({ path: '/data/codegen-cluster-test' }) };
  const executor = new GenerationExecutorService(prisma, config, workspaces, {});
  let healthCalled = false;
  executor.health = async () => { healthCalled = true; return { available: false, kind: 'kubernetes', error: 'not connected' }; };
  const prepared = await executor.prepare('session-1');
  assert.equal(prepared.verificationAvailable, false);
  assert.equal(prepared.volumePath, '/data/codegen-cluster-test');
  assert.equal(healthCalled, true);
});

test('development keeps coding when local workspace is outside the Kubernetes PVC', async () => {
  const config = { get: (key, fallback) => key === 'GENERATION_EXECUTOR' ? 'kubernetes' : key === 'NODE_ENV' ? 'development' : fallback };
  const prisma = { session: { findUnique: async () => ({ userId: 'user-1', project: { language: 'react-vite' } }) } };
  const workspaces = { ensureForSession: async () => ({ path: '/tmp/codegen-local-test' }) };
  const executor = new GenerationExecutorService(prisma, config, workspaces, {});
  executor.health = async () => { throw new Error('本机路径不应触发集群探测'); };
  const prepared = await executor.prepare('session-1');
  assert.equal(prepared.verificationAvailable, false);
  assert.equal(prepared.volumePath, '/tmp/codegen-local-test');
});

test('production rejects a workspace outside the Kubernetes PVC', async () => {
  const config = { get: (key, fallback) => key === 'GENERATION_EXECUTOR' ? 'kubernetes' : key === 'NODE_ENV' ? 'production' : fallback };
  const prisma = { session: { findUnique: async () => ({ userId: 'user-1', project: { language: 'react-vite' } }) } };
  const workspaces = { ensureForSession: async () => ({ path: '/tmp/codegen-local-test' }) };
  const executor = new GenerationExecutorService(prisma, config, workspaces, {});
  executor.health = async () => ({ available: true, kind: 'kubernetes' });
  await assert.rejects(executor.prepare('session-1'), /工作区不在共享卷根目录内/);
});
