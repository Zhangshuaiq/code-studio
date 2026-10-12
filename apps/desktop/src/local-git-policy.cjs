// Resolve once inside the workspace mutation lock; execute this same target.
async function resolveGitRemote(root, operation, requested, branch, runGit) {
  if (requested || operation === 'fetch') return requested;
  const keys = operation === 'push'
    ? [...(branch ? [`branch.${branch}.pushRemote`] : []), 'remote.pushDefault', ...(branch ? [`branch.${branch}.remote`] : [])]
    : branch ? [`branch.${branch}.remote`] : [];
  for (const key of keys) {
    const result = await runGit(root, ['config', '--get', key], { allowFailure: true });
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return 'origin';
}

async function checkGitRemotePolicy(root, status, operation, remote, runGit) {
  if (!status.enforcementRequired) return { allowed: true };
  const remotes = remote ? [remote] : (await runGit(root, ['remote'])).stdout.split(/\r?\n/).filter(Boolean);
  for (const name of remotes) {
    if (name === '.') {
      if (!status.policy.allowedGitHosts.includes('local')) return { allowed: false, host: 'local' };
      continue;
    }
    const result = await runGit(root, ['remote', 'get-url', ...(operation === 'push' ? ['--push'] : []), '--all', name], { allowFailure: true });
    const urls = result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    // Unknown remotes/groups must not turn a failed resolution into permission.
    if (result.code !== 0 || !urls.length) return { allowed: false, host: '无法确认的远程地址' };
    for (const value of urls) {
      const host = gitRemoteHost(value);
      if (!host || !status.policy.allowedGitHosts.includes(host)) return { allowed: false, host: host || '无法确认的远程地址' };
    }
  }
  return { allowed: true };
}

function gitRemoteHost(value) {
  if (/^(?:\.{0,2}\/|\/|[A-Za-z]:[\\/])/.test(value) || value.startsWith('file://')) return 'local';
  // External transport helpers can interpret their payload arbitrarily.
  if (/^[a-z][a-z0-9+.-]*::/i.test(value)) return null;
  try { const parsed = new URL(value); if (['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol) && parsed.hostname) return parsed.hostname.toLowerCase(); return null; } catch {}
  const scp = value.match(/^(?:[^@\s]+@)?([^:\s/]+):/);
  return scp ? scp[1].toLowerCase() : 'local';
}

module.exports = { resolveGitRemote, checkGitRemotePolicy, gitRemoteHost };
