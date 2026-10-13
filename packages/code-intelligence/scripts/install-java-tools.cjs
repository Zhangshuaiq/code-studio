const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const zlib = require('node:zlib');
const { Writable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const target = path.resolve(process.env.CODE_STUDIO_LANGUAGE_CACHE || path.resolve(__dirname, '../.cache'), 'java-tools');
const artifacts = [
  { name: 'lombok.jar', hash: '1e1e427c36ff63c44fd30ef292d9e773ea3154460ab6265d3fed7e6f5bc50fb9', local: path.join(os.homedir(), '.m2/repository/org/projectlombok/lombok/1.18.38/lombok-1.18.38.jar'), url: 'https://repo.maven.apache.org/maven2/org/projectlombok/lombok/1.18.38/lombok-1.18.38.jar' },
  { name: 'java-debug.jar', hash: '4a85f60e1d838476f43c95cde318aa81ade7b39cb9cfbc73b8c5a01197e020e6', local: path.join(os.homedir(), '.vscode/extensions/vscjava.vscode-java-debug-0.59.0/server/com.microsoft.java.debug.plugin-0.53.2.jar'), entry: 'extension/server/com.microsoft.java.debug.plugin-0.53.2.jar', url: 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/vscjava/vsextensions/vscode-java-debug/0.59.0/vspackage' },
];
async function readDownload(response, limit = 100 * 1024 * 1024) {
  const encoding = String(response.headers['content-encoding'] || 'identity').trim().toLowerCase();
  const decoder = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[encoding];
  if (encoding !== 'identity' && !decoder) { response.destroy(); throw new Error(`Java 工具 HTTP 编码不支持：${encoding}`); }
  const chunks = []; let size = 0;
  let wireSize = 0;
  const boundWire = new Transform({ transform(chunk, _encoding, next) { wireSize += chunk.length; if (wireSize > limit) next(new Error('Java 工具下载文件过大')); else next(null, chunk); } });
  const sink = new Writable({ write(chunk, _encoding, next) {
    size += chunk.length;
    if (size > limit) { next(new Error('Java 工具解码后文件过大')); return; }
    chunks.push(chunk); next();
  } });
  await pipeline(...[response, boundWire, decoder?.(), sink].filter(Boolean));
  return Buffer.concat(chunks);
}
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'Accept-Encoding': 'identity' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) { response.resume(); download(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject); return; }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Java 工具下载失败：HTTP ${response.statusCode}`)); return; }
      readDownload(response).then(resolve, reject);
    }); request.setTimeout(120_000, () => request.destroy(new Error('下载超时'))); request.on('error', reject);
  });
}
function extract(buffer, name) {
  if (!buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return Promise.reject(new Error('调试插件下载内容不是有效 VSIX/ZIP'));
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject); zip.on('end', () => reject(new Error('调试插件未包含预期文件')));
    zip.on('entry', (entry) => { if (entry.fileName !== name) return zip.readEntry(); zip.openReadStream(entry, (error, stream) => { if (error) return reject(error); const chunks = []; stream.on('data', (chunk) => chunks.push(chunk)); stream.on('error', reject); stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks)); }); }); }); zip.readEntry();
  }));
}
async function installJavaTools({ useLocalArtifacts = true } = {}) {
  fs.mkdirSync(target, { recursive: true });
  for (const artifact of artifacts) {
    const destination = path.join(target, artifact.name);
    let buffer = [destination, ...(useLocalArtifacts ? [artifact.local] : [])].filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file)).find((value) => crypto.createHash('sha256').update(value).digest('hex') === artifact.hash);
    if (!buffer) {
      try { buffer = await download(artifact.url); if (artifact.entry) buffer = await extract(buffer, artifact.entry); }
      catch (error) { throw new Error(`${artifact.name} 下载/解压失败：${error.message}`, { cause: error }); }
    }
    if (crypto.createHash('sha256').update(buffer).digest('hex') !== artifact.hash) throw new Error(`${artifact.name} 校验失败`);
    fs.writeFileSync(destination, buffer);
  }
}
module.exports = { installJavaTools, readDownload, download, extract };
if (require.main === module) installJavaTools().catch((error) => { console.error(error.message); process.exitCode = 1; });
