const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const plugins = path.resolve(__dirname, '../../../packages/code-intelligence/.cache/jdtls/1.61.0/plugins');
test('metadata prototype validates immutable snapshots, budgets, model copy-on-write and concurrent invalidation', { skip: !fs.existsSync(plugins) }, async t => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../scripts/build-package-metadata-probe.cjs')], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].snapshotTestsPassed, true);
  const directory = fs.realpathSync(path.dirname(rows.at(-1).bundle));
  assert.ok(directory.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  assert.match(path.basename(directory), /^jdt-package-probe-/);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.ok(fs.statSync(rows.at(-1).bundle).isFile());
});
