class LocalGitHistory {
  constructor(runGit) { this.run = runGit; this.locks = new Map(); }
  async mutate(root, action) {
    const previous = this.locks.get(root) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(root, next);
    try { return await next; } finally { if (this.locks.get(root) === next) this.locks.delete(root); }
  }
  async resolve(root, value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{7,64}$/i.test(value)) throw invalid('提交版本无效');
    const result = await this.run(root, ['rev-parse', '--verify', `${value}^{commit}`], { allowFailure: true });
    if (result.code !== 0) throw invalid('提交版本不存在');
    return result.stdout.trim();
  }
  async commits(root, offset = 0) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw invalid('历史分页无效');
    const head = await this.run(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
    if (head.code !== 0) return [];
    const result = await this.run(root, ['log', '-100', `--skip=${offset}`, '--format=%H%x00%h%x00%s%x00%at%x00%an%x00%ae', '-z', '--', '.']);
    const fields = result.stdout.split('\0'); if (fields.at(-1) === '') fields.pop();
    const commits = [];
    for (let i = 0; i + 5 < fields.length; i += 6) commits.push({ hash: fields[i], short: fields[i + 1], subject: fields[i + 2], date: Number(fields[i + 3]) * 1000, authorName: fields[i + 4], authorEmail: fields[i + 5] });
    return commits;
  }
  async diff(root, value) {
    const hash = await this.resolve(root, value);
    const parents = (await this.run(root, ['rev-list', '--parents', '-n', '1', hash])).stdout.trim().split(' ');
    const parent = parents[1];
    const prefix = (await this.run(root, ['rev-parse', '--show-prefix'])).stdout.replace(/\r?\n$/, '');
    const changed = await this.run(root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '-M', ...(parent ? [parent, hash] : [hash]), '--', '.']);
    const fields = changed.stdout.split('\0').filter(Boolean);
    const entries = [];
    for (let i = 0; i < fields.length;) {
      const status = fields[i++]; const oldPath = fields[i++];
      const target = /^[RC]/.test(status) ? fields[i++] : oldPath;
      if (!target || !target.startsWith(prefix)) continue;
      entries.push({ path: target.slice(prefix.length), oldPath, blobPath: target, kind: status[0] === 'A' ? 'added' : status[0] === 'D' ? 'deleted' : status[0] === 'R' ? 'renamed' : 'modified' });
    }
    if (entries.length > 100) throw invalid('该提交超过 100 个文件，请使用 Git 工具查看完整差异');
    let totalBytes = 0;
    const blob = async (ref, file) => {
      if (!ref) return '';
      const object = `${ref}:${file}`;
      const size = await this.run(root, ['cat-file', '-s', object], { allowFailure: true });
      if (size.code !== 0) return '';
      if (Number(size.stdout) > 256 * 1024 || totalBytes + Number(size.stdout) > 8 * 1024 * 1024) throw Object.assign(new Error('文件超过文本预览上限'), { fileType: 'too-large' });
      totalBytes += Number(size.stdout);
      const content = (await this.run(root, ['show', object])).stdout;
      if (content.includes('\0')) throw Object.assign(new Error('二进制文件无法显示文本差异'), { fileType: 'binary' });
      return content;
    };
    const results = [];
    for (const entry of entries) {
      try {
        // Sequential reads keep the per-commit byte budget predictable.
        const before = entry.kind === 'added' ? '' : await blob(parent, entry.oldPath);
        const after = entry.kind === 'deleted' ? '' : await blob(hash, entry.blobPath);
        results.push({ path: entry.path, oldPath: entry.oldPath.slice(prefix.length), kind: entry.kind, before, after });
      } catch (error) {
        if (!error.fileType) throw error;
        results.push({ path: entry.path, kind: entry.kind, before: '', after: '', fileType: error.fileType });
      }
    }
    return results;
  }
  async rollback(root, value) {
    const hash = await this.resolve(root, value);
    const dirty = await this.run(root, ['status', '--porcelain=v1', '-z']);
    if (dirty.stdout) throw invalid('请先提交或妥善保存工作区变更，再恢复历史版本');
    await this.run(root, ['restore', `--source=${hash}`, '--staged', '--worktree', '--', '.']);
    const changes = await this.run(root, ['diff', '--cached', '--quiet'], { allowFailure: true });
    if (changes.code === 0) return { restored: true, unchanged: true };
    if (changes.code !== 1) throw invalid('无法检查历史恢复结果');
    await this.run(root, ['commit', '-m', `Restore workspace to ${hash.slice(0, 12)}`]);
    return { restored: true };
  }
}
function invalid(message) { return Object.assign(new Error(message), { code: 'WORKSPACE_PATH_INVALID' }); }
module.exports = { LocalGitHistory };
