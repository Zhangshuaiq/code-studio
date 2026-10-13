const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');
async function verifyRelease(platform, arch, directory = path.resolve(__dirname, '../release')) {
  if (!['macos', 'windows'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw Error('Invalid release platform/architecture');
  const { version } = require('../package.json');
  const prefix = `Code Studio-${version}-${platform === 'macos' ? 'mac' : 'windows'}-${arch}`;
  const names = platform === 'macos' ? [prefix + '.dmg', prefix + '.zip'] : [prefix + '-Setup.exe', prefix + '-Portable.exe'];
  const sums = [];
  for (const name of names) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw Error(`Missing/empty desktop package: ${name}`);
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), new Writable({ write(chunk, _encoding, next) { hash.update(chunk); next(); } }));
    sums.push(`${hash.digest('hex')}  ${name}`);
  }
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  fs.writeFileSync(path.join(directory, 'build-info.json'), JSON.stringify({ version, platform, arch, commit: process.env.GITHUB_SHA || null, runId: process.env.GITHUB_RUN_ID || null, signed: false }, null, 2) + '\n');
  console.log(`Verified ${names.length} desktop packages (${platform}/${arch})`);
}
module.exports = { verifyRelease };
if (require.main === module) verifyRelease(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
