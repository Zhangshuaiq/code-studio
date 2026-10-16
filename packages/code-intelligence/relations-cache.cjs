const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { PARSER_VERSION } = require('./java-syntax-index.cjs');
const VERSION = `${PARSER_VERSION}/relations@1`;
const LIMIT = 16 * 1024 * 1024;
function cacheFile(directory, root) {
  return path.join(directory, crypto.createHash('sha256').update(root).digest('hex') + '.json');
}
const text = value => typeof value === 'string' && value.length <= 16384;
const strings = value => Array.isArray(value) && value.length <= 1000 && value.every(text);
const position = value => Number.isSafeInteger(value.line) && value.line > 0 && Number.isSafeInteger(value.column) && value.column > 0;
function validEntry(file, entry) {
  if (!text(file) || file.length > 1024 || path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || /[\\\0]/.test(file) || file.split('/').includes('..') || !/\.(java|xml)$/.test(file) || !text(entry?.stamp)) return false;
  if (file.endsWith('.xml')) return Array.isArray(entry.xml) && entry.xml.length <= 10000 && entry.xml.every(item => item?.path === file && position(item) && text(item.namespace) && text(item.name));
  return Array.isArray(entry.java) && entry.java.length <= 10000 && entry.java.every(item => item?.path === file && position(item) && text(item.fullName) && text(item.name) && text(item.pkg) && typeof item.isInterface === 'boolean' && strings(item.imports) && strings(item.supers) && strings(item.typeParameters) && item.superArguments && typeof item.superArguments === 'object' && Object.values(item.superArguments).every(strings) && Array.isArray(item.methods) && item.methods.length <= 10000 && item.methods.every(method => method && position(method) && text(method.name) && strings(method.parameters) && strings(method.typeParameters) && typeof method.inheritable === 'boolean'));
}
async function load(directory, root) {
  if (!directory) return new Map();
  let handle;
  try {
    handle = await fs.open(cacheFile(directory, root), require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMIT) return new Map();
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size) return new Map();
    const data = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (data.version !== VERSION || data.root !== root || !Array.isArray(data.files) || data.files.length > 10000 || !data.files.every(pair => Array.isArray(pair) && pair.length === 2 && validEntry(...pair))) return new Map();
    return new Map(data.files);
  } catch { return new Map(); }
  finally { await handle?.close(); }
}
async function save(directory, root, files) {
  if (!directory) return;
  const destination = cacheFile(directory, root), temporary = destination + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    const data = JSON.stringify({ version: VERSION, root, files: [...files] });
    if (Buffer.byteLength(data) > LIMIT) return;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, destination);
  } catch { /* Optional cache failure must not disable navigation. */ }
  finally { await fs.unlink(temporary).catch(() => {}); }
}
module.exports = { load, save };
