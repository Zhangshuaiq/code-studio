const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'build', '--workspace', 'apps/web', '--', '--outDir', '../desktop/renderer', '--emptyOutDir'],
  {
    cwd: repoRoot,
    env: { ...process.env, VITE_RUNTIME_MODE: 'desktop-local' },
    stdio: 'inherit',
    // npm.cmd needs cmd.exe on Windows; command and arguments are fixed here.
    shell: process.platform === 'win32',
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
