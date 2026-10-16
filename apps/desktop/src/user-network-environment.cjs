const { execFile } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const KEYS = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','GIT_SSL_CAINFO','SSL_CERT_FILE','SSL_CERT_DIR','CURL_CA_BUNDLE'];
function parseNetworkEnvironment(output) {
  const marker = '\0CODE_STUDIO_NETWORK_ENV\0', index = output.indexOf(marker);
  if (index < 0) throw Error('无法读取本机终端网络环境');
  const result = {};
  for (const entry of output.slice(index + marker.length).split('\0')) { const delimiter = entry.indexOf('='); if (delimiter < 1) continue; const key = entry.slice(0, delimiter), value = entry.slice(delimiter + 1); if (KEYS.includes(key) && value.length <= 16384) result[key] = value; }
  return result;
}
async function initializeUserNetworkEnvironment(options = {}) {
  if ((options.platform || process.platform) === 'win32') return { refreshed: false };
  const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  if (!['zsh','bash','sh'].includes(path.basename(shell))) return { refreshed: false };
  const env = Object.fromEntries(['USER','LOGNAME','LANG','LC_ALL','SSH_AUTH_SOCK'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.HOME = os.homedir(); env.SHELL = shell; env.TERM = 'xterm-256color'; env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';
  // Import launchd-level user settings, not proxy variables injected by the tool
  // which happened to open the app. Never log the captured environment.
  if ((options.platform || process.platform) === 'darwin') await Promise.all(KEYS.map(key => new Promise(resolve => execFile('/bin/launchctl', ['getenv', key], { timeout: 500, maxBuffer: 32768 }, (_error, value) => { if (value?.trim()) env[key] = value.trim(); resolve(); }))));
  const runner = options.execFile || execFile;
  return new Promise(resolve => runner(shell, ['-ilc', "printf '\\0CODE_STUDIO_NETWORK_ENV\\0'; /usr/bin/env -0"], { env, cwd: os.homedir(), timeout: 3000, maxBuffer: 1024 * 1024 }, (error, output) => {
    if (error) { resolve({ refreshed: false }); return; }
    try { const values = parseNetworkEnvironment(output); const target = options.target || process.env; for (const key of KEYS) { delete target[key]; if (values[key] !== undefined) target[key] = values[key]; } resolve({ refreshed: true }); }
    catch { resolve({ refreshed: false }); }
  }));
}
module.exports = { KEYS, parseNetworkEnvironment, initializeUserNetworkEnvironment };
