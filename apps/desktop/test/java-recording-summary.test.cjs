const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('binary JFR summarizer classifies index tasks before compiler helpers and escapes JSON safely', async () => {
  const { stdout } = await promisify(execFile)('java', ['-Xmx256m', path.join(__dirname, '../scripts/JavaRecordingSummary.java'), '--self-test'], { timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(stdout), { passed: true });
});
