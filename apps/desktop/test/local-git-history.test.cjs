const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { LocalGitHistory } = require('../src/local-git-history.cjs');
const { createLocalApi } = require('../src/local-api.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-git-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'History Test'); git('config', 'user.email', 'history@example.test');
  const write = (name, value) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), value); };
  const commit = message => { git('add', '--all'); git('commit', '-qm', message); return git('rev-parse', 'HEAD').trim(); };
  const history = new LocalGitHistory(async (cwd, args, options = {}) => {
    try { return { code: 0, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
    catch (error) { if (!options.allowFailure) throw error; return { code: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }; }
  });
  return { root, git, write, commit, history };
}

test('history includes root, rename, delete, binary and bounded previews; restoration adds a commit and refuses dirty files', async t => {
  const { root, git, write, commit, history } = fixture(t);
  write('old.txt', 'initial\n'); write('removed.txt', 'remove me\n');
  const initial = commit('initial version');
  assert.equal((await history.diff(root, initial)).find(item => item.path === 'old.txt').after, 'initial\n');
  git('mv', 'old.txt', 'new.txt'); git('rm', 'removed.txt');
  write('binary.dat', Buffer.from([0, 1, 2])); write('large.txt', 'x'.repeat(300 * 1024));
  const second = commit('rename and delete');
  const changes = await history.diff(root, second);
  assert.equal(changes.find(item => item.path === 'new.txt').kind, 'renamed');
  assert.equal(changes.find(item => item.path === 'new.txt').before, 'initial\n');
  assert.equal(changes.find(item => item.path === 'removed.txt').kind, 'deleted');
  assert.equal(changes.find(item => item.path === 'binary.dat').fileType, 'binary');
  assert.equal(changes.find(item => item.path === 'large.txt').fileType, 'too-large');
  const commits = await history.commits(root);
  assert.equal(commits.length, 2); assert.equal(commits[0].hash, second); assert.equal(commits[0].subject, 'rename and delete'); assert.equal(commits[0].authorName, 'History Test');
  write('untracked.txt', 'do not discard');
  await assert.rejects(history.rollback(root, initial), /先提交/);
  assert.equal(git('rev-parse', 'HEAD').trim(), second);
  fs.unlinkSync(path.join(root, 'untracked.txt'));
  await history.rollback(root, initial);
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '3');
  assert.equal(fs.readFileSync(path.join(root, 'old.txt'), 'utf8'), 'initial\n');
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
  assert.equal((await history.rollback(root, initial)).unchanged, true);
  await assert.rejects(history.diff(root, '--all'), /版本无效/);
});

test('history pagination and nested workspaces stay scoped', async t => {
  const { root, write, commit, history } = fixture(t);
  write('nested/a.txt', 'first'); write('outside.txt', 'outside'); commit('nested initial');
  for (let i = 0; i < 101; i++) { write('nested/a.txt', String(i)); commit(`version ${i}`); }
  const nested = path.join(root, 'nested');
  assert.equal((await history.commits(nested)).length, 100);
  assert.equal((await history.commits(nested, 100)).length, 2);
  const hash = (await history.commits(nested))[0].hash;
  assert.deepEqual((await history.diff(nested, hash)).map(item => item.path), ['a.txt']);
  await assert.rejects(history.commits(root, -1), /分页无效/);
});

test('Local API creates branches, commits only selected paths, keeps unrelated staging and returns real history', async t => {
  const { root, git, write, commit } = fixture(t);
  write('a.txt', 'a0'); write('b.txt', 'b0'); commit('initial');
  const api = await createLocalApi({ token: 'git-history-test' }); t.after(() => api.close());
  const project = api.registerWorkspace(root);
  const base = `${api.origin}/api/local/projects/${project.id}/git`;
  const request = async (route, body) => {
    const response = await fetch(`${base}/${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer git-history-test', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  let result = await request('checkout', { branch: 'feature/local', create: true });
  assert.equal(result.status, 200); assert.equal(result.body.status.branch, 'feature/local');
  assert.equal((await request('checkout', { branch: '--bad', create: true })).status, 400);
  assert.ok((await request('branches')).body.branches.includes('feature/local'));
  write('a.txt', 'a1'); write('b.txt', 'b1'); git('add', 'b.txt');
  result = await request('commit', { message: 'only a', paths: ['a.txt'] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(git('show', '--format=', '--name-only', 'HEAD').trim().split('\n'), ['a.txt']);
  assert.equal(git('diff', '--cached', '--name-only').trim(), 'b.txt');
  const history = (await request('commits')).body;
  assert.equal(history[0].subject, 'only a'); assert.equal(history.length, 2);
  const diff = (await request(`commits/${history[0].hash}/diff`)).body;
  assert.equal(diff[0].before, 'a0'); assert.equal(diff[0].after, 'a1');
  git('mv', 'a.txt', 'renamed.txt');
  const renamed = await request('commit', { message: 'selected rename', paths: ['renamed.txt'] });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(git('show', 'HEAD:renamed.txt'), 'a1');
  assert.equal(git('diff', '--cached', '--name-only').trim(), 'b.txt');
  write('new.txt', 'new untracked');
  assert.match((await request('diff?path=new.txt')).body.working, /new untracked/);
  assert.equal((await request('rollback', { hash: history[1].hash })).status, 400);
  const nested = path.join(root, 'child'); write('child/new.txt', 'nested');
  const nestedProject = api.registerWorkspace(nested);
  const status = await (await fetch(`${api.origin}/api/local/projects/${nestedProject.id}/git/status`, { headers: { Authorization: 'Bearer git-history-test' } })).json();
  assert.deepEqual(status.files.map(item => item.path), ['new.txt']);
});

test('unborn branch reports a usable name and can be created before first commit', async t => {
  const { root, write } = fixture(t);
  const api = await createLocalApi({ token: 'git-unborn-test' }); t.after(() => api.close());
  const project = api.registerWorkspace(root);
  const base = `${api.origin}/api/local/projects/${project.id}/git`;
  const headers = { Authorization: 'Bearer git-unborn-test', 'Content-Type': 'application/json' };
  assert.equal((await (await fetch(`${base}/status`, { headers })).json()).branch, 'main');
  assert.deepEqual((await (await fetch(`${base}/commits`, { headers })).json()), []);
  const switched = await fetch(`${base}/checkout`, { method: 'POST', headers, body: JSON.stringify({ branch: 'first', create: true }) });
  assert.equal(switched.status, 200);
  write('first.txt', 'first');
  const response = await fetch(`${base}/commit`, { method: 'POST', headers, body: JSON.stringify({ message: 'first commit', paths: ['first.txt'] }) });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
});
