const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { decodeText } = require('./file-text.cjs');
const exec = promisify(execFile);
const invalid = message => Object.assign(new Error(message), { code: 'GIT_COMPARE_INVALID' });
async function git(root, args, allowFailure = false) {
  try { const result = await exec('git', args, { cwd: root, encoding: 'buffer', timeout: 15000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }); return result.stdout; }
  catch (error) { if (allowFailure && Number.isInteger(error.code)) return null; throw invalid('无法读取 Git 对比，请确认仓库和版本有效'); }
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\0]/.test(value) || path.isAbsolute(value) || value.split('/').some(p => p === '..' || p.toLowerCase() === '.git')) throw invalid('文件路径无效');
  return value;
}
async function ref(root, value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\0\r\n]/.test(value)) throw invalid('分支或版本无效');
  const result = await git(root, ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], true);
  if (!result || !/^[a-f0-9]{40,64}$/.test(result.toString().trim())) throw invalid('分支或版本不存在'); return result.toString().trim();
}
async function blob(root, object) {
  const size = await git(root, ['cat-file', '-s', object], true);
  if (!size) return { content: '', exists: false };
  if (Number(size) > 1024 * 1024) return { content: '', exists: true, fileType: 'too-large' };
  const bytes = await git(root, ['cat-file', 'blob', object]);
  try { const decoded = decodeText(bytes); if (bytes.includes(0) && !decoded.encoding?.startsWith('utf-16')) return { content: '', exists: true, fileType: 'binary' }; return { content: decoded.content, exists: true }; }
  catch { return { content: '', exists: true, fileType: 'binary' }; }
}
async function scope(root) { root = await fs.realpath(root); const prefix = (await git(root, ['rev-parse', '--show-prefix'])).toString().replace(/\r?\n$/, ''); return { root, prefix }; }
async function compareBranches(directory, left, right, offset = 0, limit = 200) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('分页无效');
  const { root, prefix } = await scope(directory), leftHash = await ref(root, left), rightHash = await ref(root, right);
  const fields = (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', leftHash, rightHash, '--', '.'])).toString().split('\0');
  const entries = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++], oldPath = fields[i++], file = /^[RC]/.test(status) ? fields[i++] : oldPath;
    if (!file?.startsWith(prefix)) continue;
    entries.push({ path: file.slice(prefix.length), oldPath: oldPath.startsWith(prefix) ? oldPath.slice(prefix.length) : undefined, kind: status[0] === 'A' ? 'added' : status[0] === 'D' ? 'deleted' : status[0] === 'R' ? 'renamed' : 'modified' });
  }
  return { left: leftHash, right: rightHash, items: entries.slice(offset, offset + limit), total: entries.length, offset, hasMore: offset + limit < entries.length };
}
async function branchFile(directory, left, right, value, previous) {
  const file = relative(value), oldPath = relative(previous || value);
  const { root, prefix } = await scope(directory), leftHash = await ref(root, left), rightHash = await ref(root, right);
  const before = await blob(root, `${leftHash}:${prefix}${oldPath}`), after = await blob(root, `${rightHash}:${prefix}${file}`);
  return { path: file, before: before.content, after: after.content, fileType: before.fileType || after.fileType, left: leftHash, right: rightHash };
}
async function workingFile(directory, value, stage = 'working') {
  const file = relative(value); if (!['working', 'staged'].includes(stage)) throw invalid('对比范围无效');
  const { root, prefix } = await scope(directory);
  const before = await blob(root, stage === 'staged' ? `HEAD:${prefix}${file}` : `:${prefix}${file}`);
  let after;
  if (stage === 'staged') after = await blob(root, `:${prefix}${file}`);
  else {
    let current = root;
    for (const segment of file.split('/')) {
      current = path.join(current, segment);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw invalid('符号链接不支持工作区文本对比'); }
      catch (error) { if (error.code === 'ENOENT') { current = null; break; } throw error; }
    }
    if (!current) after = { content: '', exists: false };
    else {
      const stat = await fs.stat(current);
      if (!stat.isFile() || stat.size > 1024 * 1024) after = { content: '', exists: true, fileType: 'too-large' };
      else {
        const handle = await fs.open(current, require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0));
        try {
          const buffer = Buffer.alloc(1024 * 1024 + 1), read = await handle.read(buffer, 0, buffer.length, 0), bytes = buffer.subarray(0, read.bytesRead);
          if (bytes.length > 1024 * 1024) after = { content: '', exists: true, fileType: 'too-large' };
          else { try { const decoded = decodeText(bytes); after = { content: decoded.content, exists: true, fileType: bytes.includes(0) && !decoded.encoding?.startsWith('utf-16') ? 'binary' : undefined }; } catch { after = { content: '', exists: true, fileType: 'binary' }; } }
        } finally { await handle.close(); }
      }
    }
  }
  return { path: file, before: before.content, after: after.content, fileType: before.fileType || after.fileType, exists: after.exists, stage };
}
module.exports = { compareBranches, branchFile, workingFile, git, relative, ref, blob, scope };
