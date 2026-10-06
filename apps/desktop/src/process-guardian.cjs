const { spawn } = require('node:child_process');

const parentPid = Number(process.argv[2]);
const command = process.argv[3];
let args;
try { args = JSON.parse(Buffer.from(process.argv[4] || '', 'base64url').toString('utf8')); } catch { args = null; }
if (!Number.isInteger(parentPid) || parentPid < 1 || !command || !Array.isArray(args)) process.exit(64);

const child = spawn(command, args, { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true, detached: process.platform !== 'win32' });
let finishing = false;
const terminate = () => {
  if (finishing) return; finishing = true;
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} } }
  const timer = setTimeout(() => { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {} process.exit(143); }, 2_000); timer.unref();
};
const monitor = setInterval(() => { try { process.kill(parentPid, 0); } catch { terminate(); } }, 500);
monitor.unref();
process.on('SIGTERM', terminate); process.on('SIGINT', terminate);
child.once('error', () => process.exit(127));
child.once('close', (code, signal) => { finishing = true; clearInterval(monitor); process.exitCode = code ?? (signal ? 128 : 1); });
