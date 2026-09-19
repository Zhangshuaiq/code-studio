const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { AgentRuntimeStateService } = require('../dist/agent/agent-runtime-state.service.js');
const { CodexAccountService, parseCodexDeviceInstructions } = require('../dist/agent/codex-account.service.js');

test('Codex device instructions accept ANSI output and variable-length codes', () => {
  const output = '\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\nEnter this one-time code\n\u001b[94mAB12-CDE34\u001b[0m\n';
  assert.deepEqual(parseCodexDeviceInstructions(output), {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'AB12-CDE34',
  });
  assert.deepEqual(parseCodexDeviceInstructions('https://auth.openai.com/codex/device\nAB12-CDE3\n'), {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'AB12-CDE3',
  });
  assert.equal(parseCodexDeviceInstructions('Error logging in with device code: network unavailable'), null);
});

test('Codex requires each user to connect their own account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-account-test-'));
  try {
    const state = new AgentRuntimeStateService({ get: (key, fallback) => key === 'AGENT_STATE_ROOT' ? root : fallback });
    const accounts = new CodexAccountService(state, { systemSetting: {
      findUnique: async () => null,
      create: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
    } });
    assert.notEqual(await state.home('user-a', 'codex'), await state.home('user-b', 'codex'));
    assert.deepEqual(await accounts.status('user-a'), { connected: false });
    await assert.rejects(accounts.assertConnected('user-b'), /账号尚未连接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host login already claimed by another platform user cannot be bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-host-owner-test-'));
  try {
    const state = new AgentRuntimeStateService({ get: (key, fallback) => key === 'AGENT_STATE_ROOT' ? root : fallback });
    const accounts = new CodexAccountService(state, { systemSetting: {
      findUnique: async () => ({ updatedById: 'user-a' }),
    } });
    accounts.hostLoginStatus = async () => ({ detected: true, bindable: true });
    await assert.rejects(accounts.bindHostLogin('user-b'), /已绑定其他平台用户/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
