const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { git, relative, ref, blob, scope, workingFile } = require('./git-comparison.cjs');
const fail = message => { throw new Error(message); };
async function repository(root) {
  const result = await scope(root);
  if (result.prefix) fail('合并操作需要从 Git 仓库根目录打开项目');
  return result.root;
}
async function status(root) {
  const conflicts = (await git(root, ['diff', '--name-only', '--diff-filter=U', '-z', '--', '.'])).toString().split('\0').filter(Boolean);
  const merge = await git(root, ['rev-parse', '--verify', 'MERGE_HEAD'], true);
  return { conflicts, mergeInProgress: !!merge };
}
function parseMarkers(content) {
  let state = 'normal', ours = '', theirs = '', both = '', a = '', b = '', base = '', hunks = [];
  const join = (a, b) => a + (a && b && !a.endsWith('\n') ? '\n' : '') + b;
  for (const line of content.match(/.*(?:\n|$)/g)?.filter(Boolean) || []) {
    if (state === 'normal' && /^<{7,} /.test(line)) { state = 'ours'; a = b = base = ''; }
    else if (state === 'ours' && /^\|{7,} /.test(line)) state = 'base';
    else if (['ours', 'base'].includes(state) && /^={7,}\r?\n?$/.test(line)) state = 'theirs';
    else if (state === 'theirs' && /^>{7,} /.test(line)) {
      hunks.push({ index: hunks.length, ours: a, theirs: b, base, oursStart: ours.length, oursEnd: ours.length + a.length, theirsStart: theirs.length, theirsEnd: theirs.length + b.length, resultStart: ours.length, resultEnd: ours.length + a.length });
      ours += a; theirs += b; both += join(a, b); state = 'normal';
    } else if (state === 'normal') { ours += line; theirs += line; both += line; }
    else if (state === 'ours') a += line;
    else if (state === 'base') base += line;
    else b += line;
  }
  return state === 'normal' ? { ours, theirs, both, hunks } : { ours: content, theirs: content, both: content, hunks: [] };
}
async function target(root, file) {
  relative(file); let current = root;
  for (const piece of file.split('/')) {
    current = path.join(current, piece);
    const st = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (st?.isSymbolicLink()) fail('不支持符号链接冲突文件');
  }
  return current;
}
async function detail(directory, file) {
  const root = await repository(directory); await target(root, file);
  if (!(await status(root)).conflicts.includes(file)) fail('该文件不是当前未解决的冲突');
  const stages = (await git(root, ['ls-files', '-u', '-z', '--', `:(literal)${file}`])).toString();
  const entries = new Map(stages.split('\0').filter(Boolean).map(row => { const m = /^(\d+) ([a-f0-9]+) ([123])\t/.exec(row); if (!m || m[1] === '120000') fail('不支持此类型冲突'); return [Number(m[3]), m[2]]; }));
  const version = async n => { const value = entries.has(n) ? await blob(root, entries.get(n)) : { exists: false, content: '' }; return { exists: value.exists, size: Buffer.byteLength(value.content), content: value.fileType ? null : value.content, fileType: value.fileType }; };
  const [base, ours, theirs, working] = await Promise.all([version(1), version(2), version(3), workingFile(root, file)]);
  const result = { exists: working.exists, size: Buffer.byteLength(working.after), content: working.fileType ? null : working.after };
  const parsed = parseMarkers(result.content || '');
  const fileType = [base, ours, theirs].some(v => v.fileType === 'binary') || working.fileType === 'binary' ? 'binary' : [base, ours, theirs].some(v => v.fileType) || working.fileType ? 'too-large' : 'text';
  const token = crypto.createHash('sha256').update(JSON.stringify([stages, result, (await git(root, ['rev-parse', 'HEAD'])).toString(), (await git(root, ['rev-parse', '--verify', 'MERGE_HEAD'], true))?.toString()])).digest('hex');
  return { path: file, version: token, conflictType: !base.exists ? 'both-added' : !ours.exists ? 'deleted-by-us' : !theirs.exists ? 'deleted-by-them' : 'content', fileType, base, ours, theirs, result,
    suggestions: { ours: parsed.hunks.length ? parsed.ours : ours.content, theirs: parsed.hunks.length ? parsed.theirs : theirs.content, both: parsed.hunks.length ? parsed.both : null }, hunks: parsed.hunks };
}
async function resolve(directory, input) {
  const root = await repository(directory), current = await detail(root, input.path);
  if (!input.version || input.version !== current.version) fail('冲突文件已变化，请重新打开后解决');
  const file = await target(root, input.path);
  if (input.resolution === 'delete') await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  else {
    if (current.fileType !== 'text') fail('二进制或大文件请在外部解决后暂存');
    const content = input.resolution === 'manual' ? input.content : current.suggestions[input.resolution];
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) fail('解决内容无效');
    if (/^(?:<{7,} |={7,}\r?$|>{7,} )/m.test(content)) fail('结果仍包含冲突标记');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const handle = await fs.open(file, require('node:fs').constants.O_WRONLY | require('node:fs').constants.O_CREAT | (require('node:fs').constants.O_NOFOLLOW || 0));
    try { await handle.truncate(0); await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
  }
  await git(root, ['add', '--', `:(literal)${input.path}`]);
  return { path: input.path, resolved: true, remaining: (await status(root)).conflicts };
}
async function merge(directory, action, branch) {
  const root = await repository(directory), current = await status(root);
  if (action === 'start') {
    if (current.mergeInProgress || current.conflicts.length) fail('请先完成或中止当前合并');
    if ((await git(root, ['status', '--porcelain', '-z'])).length) fail('请先提交或暂存到 stash 当前修改后再合并');
    const commit = await ref(root, branch);
    const result = await git(root, ['-c', 'core.hooksPath=/dev/null', 'merge', '--no-commit', '--no-ff', commit], true);
    const next = await status(root); if (!result && !next.mergeInProgress && !next.conflicts.length) fail('合并失败，请检查 Git 配置'); return next;
  }
  if (!current.mergeInProgress) fail('当前没有进行中的合并');
  if (action === 'continue') { if (current.conflicts.length) fail('还有未解决的冲突'); await git(root, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--no-edit']); }
  else if (action === 'abort') await git(root, ['merge', '--abort']);
  else fail('不支持的合并操作');
  return status(root);
}
module.exports = { status, detail, resolve, merge, parseMarkers };
