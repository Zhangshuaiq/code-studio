const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const target = path.resolve(__dirname, '../.cache/java-tools');
const artifacts = [
  { name: 'lombok.jar', hash: '1e1e427c36ff63c44fd30ef292d9e773ea3154460ab6265d3fed7e6f5bc50fb9', local: path.join(os.homedir(), '.m2/repository/org/projectlombok/lombok/1.18.38/lombok-1.18.38.jar'), url: 'https://repo.maven.apache.org/maven2/org/projectlombok/lombok/1.18.38/lombok-1.18.38.jar' },
  { name: 'java-debug.jar', hash: '4a85f60e1d838476f43c95cde318aa81ade7b39cb9cfbc73b8c5a01197e020e6', local: path.join(os.homedir(), '.vscode/extensions/vscjava.vscode-java-debug-0.59.0/server/com.microsoft.java.debug.plugin-0.53.2.jar'), entry: 'extension/server/com.microsoft.java.debug.plugin-0.53.2.jar', url: 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/vscjava/vsextensions/vscode-java-debug/0.59.0/vspackage' },
];
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'Accept-Encoding': 'identity' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) { response.resume(); download(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject); return; }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Java 工具下载失败：HTTP ${response.statusCode}`)); return; }
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 100 * 1024 * 1024) response.destroy(new Error('下载文件过大')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject);
    }); request.setTimeout(120_000, () => request.destroy(new Error('下载超时'))); request.on('error', reject);
  });
}
function extract(buffer, name) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject); zip.on('end', () => reject(new Error('调试插件未包含预期文件')));
    zip.on('entry', (entry) => { if (entry.fileName !== name) return zip.readEntry(); zip.openReadStream(entry, (error, stream) => { if (error) return reject(error); const chunks = []; stream.on('data', (chunk) => chunks.push(chunk)); stream.on('error', reject); stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks)); }); }); }); zip.readEntry();
  }));
}
(async () => {
  fs.mkdirSync(target, { recursive: true });
  for (const artifact of artifacts) {
    const destination = path.join(target, artifact.name);
    let buffer = [destination, artifact.local].filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file)).find((value) => crypto.createHash('sha256').update(value).digest('hex') === artifact.hash);
    if (!buffer) { buffer = await download(artifact.url); if (artifact.entry) buffer = await extract(buffer, artifact.entry); }
    if (crypto.createHash('sha256').update(buffer).digest('hex') !== artifact.hash) throw new Error(`${artifact.name} 校验失败`);
    fs.writeFileSync(destination, buffer);
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
