const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalAgentRuntime } = require('../src/local-agent-runtime.cjs');

test('command lifecycle and replay display once, distinct executions remain distinct', () => {
  const events = [];
  const runtime = new LocalAgentRuntime({ store: { addAgentEvent: (task, event) => events.push({ task, ...event }) } });
  const run = {};
  const emit = (type, id, task = 'task1') => runtime.forwardLine(task, JSON.stringify({ type, item: { id, type: 'command_execution', command: 'pwd' } }), undefined, run);
  emit('item.started', 'a');
  emit('item.updated', 'a');
  emit('item.completed', 'a');
  emit('item.completed', 'a');
  emit('item.completed', 'b'); // Completion-only streams still display the command.
  emit('item.started', 'a', 'task2');
  assert.equal(events.length, 3);
  assert.ok(events.every(event => event.toolName === '命令执行' && event.toolInput === 'pwd'));
});

test('events without invocation IDs are not collapsed by command text', () => {
  const events = [];
  const runtime = new LocalAgentRuntime({ store: { addAgentEvent: (_, event) => events.push(event) } });
  const run = {};
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'echo secret' } });
  runtime.forwardLine('task', line, 'secret', run);
  runtime.forwardLine('task', line, 'secret', run);
  assert.equal(events.length, 2);
  assert.ok(events.every(event => !event.toolInput.includes('secret')));
});
