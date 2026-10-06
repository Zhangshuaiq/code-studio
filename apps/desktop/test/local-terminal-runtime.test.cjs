const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalTerminalRuntime } = require('../src/local-terminal-runtime.cjs');

test('PTY terminal starts in the project, streams output, resizes and exits cleanly', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-terminal-'));
  const runtime = new LocalTerminalRuntime(); t.after(async () => { await runtime.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  const session = runtime.create({ id: 'project', path: directory }, { cols: 80, rows: 24 });
  assert.equal(session.status, 'running'); assert.equal(session.cwd, directory); assert.equal(runtime.resize(session.id, 120, 40), true);
  runtime.write(session.id, `printf 'terminal-ready\\n'; pwd; exit\n`);
  let state = runtime.output(session.id, 0);
  for (let attempt = 0; attempt < 200 && state.status === 'running'; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 20)); state = runtime.output(session.id, 0); }
  const output = state.chunks.map((item) => item.data).join('');
  assert.match(output, /terminal-ready/); assert.match(output, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); assert.equal(state.status, 'exited');
  assert.equal(runtime.close(session.id), true); assert.equal(runtime.get(session.id), undefined);
});
