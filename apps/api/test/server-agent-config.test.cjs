const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelConfigService } = require('../dist/model-config/model-config.service.js');

function setup() {
  let saved;
  const prisma = {
    modelConfig: {
      count: async () => 0,
      create: async ({ data }) => (saved = { ...data, id: 'config-1', createdAt: new Date() }),
      findFirst: async () => saved,
      updateMany: async () => {},
    },
    $transaction: async (operation) => operation(prisma),
  };
  const crypto = { encrypt: (text) => `encrypted:${text}`, decrypt: (text) => text.slice(10) };
  return { service: new ModelConfigService(prisma, crypto), getSaved: () => saved };
}

test('Codex agent requires a personal API key and selects model per session', async () => {
  const { service, getSaved } = setup();
  await assert.rejects(service.create('user-1', { label: 'Codex', engine: 'codex' }), /自己的 API 凭证/);
  const created = await service.create('user-1', { label: 'Codex', engine: 'codex', apiKey: 'my-key' });
  assert.equal(getSaved().provider, 'openai');
  assert.equal(getSaved().model, '');
  await assert.rejects(service.resolveForGeneration('user-1', created.id), /选择模型/);
  const resolved = await service.resolveForGeneration('user-1', created.id, 'gpt-5.5');
  assert.equal(resolved.engine, 'codex');
  assert.equal(resolved.apiKey, 'my-key');
  assert.equal(resolved.model, 'gpt-5.5');
});

test('API model still requires all API connection fields', async () => {
  const { service } = setup();
  await assert.rejects(service.create('user-1', { label: 'API', engine: 'simple' }),
    /API 模型需要 Base URL、模型名称和 API Key/);
});

test('DeepSeek agent stores each user key and pins its official endpoint', async () => {
  const { service, getSaved } = setup();
  await service.create('user-1', {
    label: 'DeepSeek', engine: 'deepseek-agent', model: 'deepseek-v4-pro',
    baseUrl: 'https://untrusted.example', apiKey: 'user-owned-key',
  });
  assert.equal(getSaved().baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(getSaved().encryptedKey, 'encrypted:user-owned-key');
  assert.equal(getSaved().model, '');
  const resolved = await service.resolveForGeneration('user-1', getSaved().id, 'deepseek-v4-pro');
  assert.equal(resolved.apiKey, 'user-owned-key');
  assert.equal(resolved.engine, 'deepseek-agent');
});

test('GLM agent requires a user key and never accepts a custom endpoint', async () => {
  const { service, getSaved } = setup();
  await assert.rejects(service.create('user-1', { label: 'GLM', engine: 'glm-agent' }), /用户自己的 API 凭证/);
  await service.create('user-1', { label: 'GLM', engine: 'glm-agent', apiKey: 'glm-user-key' });
  assert.equal(getSaved().baseUrl, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(getSaved().model, '');
  assert.equal((await service.resolveForGeneration('user-1', getSaved().id, 'glm-5.2')).apiKey, 'glm-user-key');
});

test('Claude agent accepts personal API key without a model at connection time', async () => {
  const { service, getSaved } = setup();
  const created = await service.create('user-1', { label: 'Claude', engine: 'claude-code', apiKey: 'claude-key' });
  assert.equal(getSaved().model, '');
  assert.equal(getSaved().baseUrl, 'https://api.anthropic.com');
  assert.equal((await service.resolveForGeneration('user-1', created.id, 'claude-sonnet-5')).model, 'claude-sonnet-5');
});

test('model discovery uses the owning user credential and fixed provider endpoint', async () => {
  const { service, getSaved } = setup();
  await service.create('user-1', { label: 'DeepSeek', engine: 'deepseek-agent', apiKey: 'private-key' });
  const originalFetch = global.fetch;
  let call;
  global.fetch = async (url, options) => {
    call = { url, authorization: options.headers.authorization };
    return { ok: true, json: async () => ({ data: [{ id: 'deepseek-v4-pro' }] }) };
  };
  try {
    const result = await service.availableModels('user-1', getSaved().id);
    assert.deepEqual(result.models, [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }]);
    assert.equal(call.url, 'https://api.deepseek.com/models');
    assert.equal(call.authorization, 'Bearer private-key');
  } finally { global.fetch = originalFetch; }
});
