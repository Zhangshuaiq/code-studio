const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const exec = promisify(execFile);
async function readRecording(filename) {
  const { stdout } = await exec('java', ['-Xmx256m', path.join(__dirname, 'JavaRecordingSummary.java'), filename], { timeout: 60000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}
module.exports = { readRecording };
if (require.main === module) readRecording(process.argv[2]).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
