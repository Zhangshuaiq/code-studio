const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliInvocation, verifiedWorkspaceRoot } = require('../src/local-agent-runtime.cjs');

test('Codex invocation ignores project configuration and enforces its sandbox profile', () => {
  const readOnly = cliInvocation({ engine: 'codex-cli', model: '' }, 'inspect', 'read-only');
  assert.ok(readOnly.args.includes('--ephemeral'));
  assert.ok(readOnly.args.includes('--ignore-user-config'));
  assert.equal(readOnly.args[readOnly.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(readOnly.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);

  const writable = cliInvocation({ engine: 'codex-cli', model: 'gpt-test', reasoningEffort: 'high' }, 'edit', 'workspace-write');
  assert.equal(writable.args[writable.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(writable.args[writable.args.indexOf('--model') + 1], 'gpt-test');
  assert.equal(writable.args[writable.args.indexOf('--config') + 1], 'model_reasoning_effort="high"');
});

test('Claude exposes only read tools until workspace editing is explicitly authorized', () => {
  const readOnly = cliInvocation({ engine: 'claude-code', model: '' }, 'inspect', 'read-only');
  assert.equal(readOnly.args[readOnly.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(readOnly.args[readOnly.args.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(readOnly.args.includes('--strict-mcp-config'));
  assert.ok(readOnly.args.includes('--disable-slash-commands'));

  const writable = cliInvocation({ engine: 'claude-code', model: '' }, 'edit', 'workspace-write');
  const tools = writable.args[writable.args.indexOf('--tools') + 1];
  assert.match(tools, /Edit/);
  assert.equal(tools.includes('Bash'), false);
  assert.equal(writable.args[writable.args.indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('Aider is workspace-write only and constrained to the workspace subtree', () => {
  const config = { engine: 'aider', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local', apiKey: 'secret' };
  assert.throws(() => cliInvocation(config, 'inspect', 'read-only'), /明确授权/);
  assert.ok(cliInvocation(config, 'edit', 'workspace-write').args.includes('--subtree-only'));
});

test('Agent execution accepts only a stable canonical workspace directory', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-agent-boundary-'));
  const workspace = fs.realpathSync(directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(verifiedWorkspaceRoot({ path: workspace }), workspace);
  assert.throws(() => verifiedWorkspaceRoot({ path: path.join(workspace, 'missing') }), /不存在|无法访问/);
  const alias = path.join(path.dirname(workspace), `${path.basename(workspace)}-alias`);
  fs.symlinkSync(workspace, alias, 'dir');
  t.after(() => fs.rmSync(alias, { force: true }));
  assert.throws(() => verifiedWorkspaceRoot({ path: alias }), /发生变化/);
});
