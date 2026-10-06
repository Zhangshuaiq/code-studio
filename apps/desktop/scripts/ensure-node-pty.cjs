const fs = require('node:fs');
const path = require('node:path');

for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = path.resolve(__dirname, '..', '..', '..', 'node_modules', 'node-pty', 'prebuilds', arch, 'spawn-helper');
  if (!fs.existsSync(helper)) continue;
  const mode = fs.statSync(helper).mode & 0o777;
  if ((mode & 0o111) === 0) fs.chmodSync(helper, mode | 0o755);
}
