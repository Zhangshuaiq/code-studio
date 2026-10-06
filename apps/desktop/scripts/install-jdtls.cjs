const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const tar = require('tar');

const VERSION = '1.61.0';
const ARCHIVE = 'jdt-language-server-1.61.0-202609031315.tar.gz';
const SHA256 = '338e7e73d61836651ba2453919a0d34fa763eb4e7c03342092309bffb8934c64';
const cacheRoot = path.resolve(__dirname, '..', '.cache', 'jdtls');
const target = path.join(cacheRoot, VERSION);

if (fs.existsSync(path.join(target, 'plugins')) && fs.existsSync(path.join(target, platformConfig()))) process.exit(0);
fs.mkdirSync(cacheRoot, { recursive: true });
const archivePath = path.join(cacheRoot, ARCHIVE);

download(`https://download.eclipse.org/jdtls/milestones/${VERSION}/${ARCHIVE}`, archivePath).then(async () => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  if (digest !== SHA256) throw new Error(`JDT LS 校验失败：期望 ${SHA256}，实际 ${digest}`);
  const temporary = `${target}.installing-${process.pid}`; fs.rmSync(temporary, { recursive: true, force: true }); fs.mkdirSync(temporary, { recursive: true });
  await tar.x({ file: archivePath, cwd: temporary, strict: true });
  fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(temporary, target); fs.rmSync(archivePath, { force: true });
}).catch((error) => { console.error(error.message); process.exit(1); });

function platformConfig() { if (process.platform === 'win32') return 'config_win'; const base = process.platform === 'darwin' ? 'config_mac' : 'config_linux'; return process.arch === 'arm64' ? `${base}_arm` : base; }
function download(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) { response.resume(); download(new URL(response.headers.location, url).toString(), destination, redirects + 1).then(resolve, reject); return; }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`下载 JDT LS 失败（HTTP ${response.statusCode}）`)); return; }
      const output = fs.createWriteStream(destination, { mode: 0o600 }); response.pipe(output); output.on('finish', () => output.close(resolve)); output.on('error', reject);
    }); request.setTimeout(120_000, () => request.destroy(new Error('下载 JDT LS 超时'))); request.on('error', reject);
  });
}
