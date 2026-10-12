const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { decodeText, encodeText, textEncoding } = require('./file-text.cjs');

function invalid(message) { return Object.assign(new Error(message), { status: 400, code: 'GIT_BLAME_INVALID' }); }
function command(root, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--literal-pathspecs', ...args], { cwd: root, timeout: 15000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => error ? reject(invalid('无法读取行注释：文件尚未提交、仓库不可用或操作超时')) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function parseBlame(output) {
  const result = []; let current;
  for (const row of output.split('\n')) {
    const header = row.match(/^([a-f0-9]{40,64}) (\d+) (\d+)(?: \d+)?$/);
    if (header) { current = { hash: header[1], originalLine: Number(header[2]), line: Number(header[3]), uncommitted: /^0+$/.test(header[1]) }; continue; }
    if (!current) continue;
    if (row.startsWith('\t')) { result.push(current); current = undefined; continue; }
    const space = row.indexOf(' '); const key = space < 0 ? row : row.slice(0, space); const value = row.slice(space + 1);
    if (key === 'author') current.author = value;
    if (key === 'author-mail') current.email = value.replace(/^<|>$/g, '');
    if (key === 'author-time') current.date = Number(value);
    if (key === 'summary') current.summary = value;
    if (key === 'filename') current.filename = value;
    if (key === 'previous') current.previous = value;
  }
  return result;
}
async function gitBlame(root, file, content) {
  if (typeof file !== 'string' || file.length > 1024 || file.includes('\0') || file.includes('\\') || path.isAbsolute(file) || /^[a-z]:/i.test(file) || file.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw invalid('请选择工作区内的普通文件');
  root = fs.realpathSync(root);
  let absolute = root;
  for (const part of file.split('/')) { absolute = path.join(absolute, part); if (fs.lstatSync(absolute).isSymbolicLink()) throw invalid('不支持符号链接文件的行注释'); }
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw invalid('行注释仅支持 1 MiB 以内的文本文件');
  if (content !== undefined && typeof content !== 'string') throw invalid('文件内容格式无效');
  const original = fs.readFileSync(absolute); let format;
  try { format = textEncoding(original); } catch { throw invalid('该文本编码暂不支持 Git 行注释'); }
  if (format.encoding !== 'utf-8') throw invalid('UTF-16 文件暂不支持 Git 行注释，源码仍可正常编辑');
  let source;
  try { source = content === undefined ? decodeText(original).content : content; } catch { throw invalid('该文本编码暂不支持 Git 行注释'); }
  if (Buffer.byteLength(source) > 1024 * 1024 || source.includes('\0') || source.split('\n').length > 20000) throw invalid('行注释仅支持 1 MiB、20000 行以内的文本文件');
  const repo = (await command(root, ['rev-parse', '--show-toplevel'])).trim();
  if (!(root === fs.realpathSync(repo) || root.startsWith(fs.realpathSync(repo) + path.sep))) throw invalid('文件不属于当前仓库');
  const rows = parseBlame(await command(root, ['blame', '--line-porcelain', '--contents', '-', '--', file], encodeText(source, format)));
  return { path: file, lines: rows };
}
module.exports = { gitBlame: async (...args) => {
  try { return await gitBlame(...args); }
  catch (error) { if (error.code === 'GIT_BLAME_INVALID') throw error; throw invalid('无法读取行注释，请确认文件存在且仓库可用'); }
}, parseBlame };
