const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

test('process guardian terminates the full child tree when its desktop parent is gone', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-guardian-')); const marker = path.join(directory, 'leaked.txt');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const command = process.execPath; const childArgs = ['-e', `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'leaked'),1500)`];
  const guardian = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'process-guardian.cjs'), '99999999', command, Buffer.from(JSON.stringify(childArgs)).toString('base64url')], { cwd: directory, stdio: 'ignore' });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('guardian did not exit')), 4_000); guardian.once('close', () => { clearTimeout(timer); resolve(); }); });
  await new Promise((resolve) => setTimeout(resolve, 1_700)); assert.equal(fs.existsSync(marker), false);
});
