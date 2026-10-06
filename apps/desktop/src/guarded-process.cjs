const path = require('node:path');
const { spawn } = require('node:child_process');

function spawnGuarded(command, args, options = {}) {
  const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64url');
  return spawn(process.execPath, [path.join(__dirname, 'process-guardian.cjs'), String(process.pid), command, encodedArgs], {
    ...options,
    env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

module.exports = { spawnGuarded };
