const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { AgentRuntimeStateService } = require('../dist/agent/agent-runtime-state.service.js');
const { CodexAccountService } = require('../dist/agent/codex-account.service.js');

test('Codex requires each user to connect their own account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-account-test-'));
  try {
    const state = new AgentRuntimeStateService({ get: (key, fallback) => key === 'AGENT_STATE_ROOT' ? root : fallback });
    const accounts = new CodexAccountService(state);
    assert.notEqual(await state.home('user-a', 'codex'), await state.home('user-b', 'codex'));
    assert.deepEqual(await accounts.status('user-a'), { connected: false });
    await assert.rejects(accounts.assertConnected('user-b'), /账号尚未连接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
