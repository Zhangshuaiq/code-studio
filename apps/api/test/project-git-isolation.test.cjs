const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { realpathSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { WorkspaceService } = require('../dist/workspace/workspace.service.js');
const { WorkspaceStorageService } = require('../dist/workspace/workspace-storage.service.js');
const { GitService } = require('../dist/git/git.service.js');
const { repositoryName } = require('../dist/git/git-url.js');
const { CreateProjectDto } = require('../dist/project/dto/create-project.dto.js');
const { validateSync } = require('class-validator');

test('a project inside another Git repository gets its own repository root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'project-git-isolation-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'platform'], { cwd: parent });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-q', '-m', 'platform'], { cwd: parent });
    const projectsRoot = join(parent, 'projects');
    const project = { id: 'project-1', userId: 'owner-1', storageKey: 'primary', storagePath: 'project-1', volumePath: '', remote: { branch: '' } };
    const config = { get: (key, fallback) => ({ SANDBOX_PROJECTS_ROOT: projectsRoot, SANDBOX_WORKSPACES_ROOT: join(parent, 'workspaces'), DEPLOY_WORKSPACES_ROOT: join(parent, 'deployments') })[key] || fallback };
    const storage = new WorkspaceStorageService(config);
    const session = { id: 'session-1', projectId: project.id, project, user: { username: 'owner' }, accessRole: 'owner', workspacePath: null, workspaceBranch: null };
    const prisma = { user: { findUnique: async () => ({ username: 'owner', email: 'owner@example.com', gitProfile: null }) }, session: { update: async () => ({}) } };
    const service = new WorkspaceService(prisma, config, { requireSession: async () => session }, { runExclusive: async (_key, work) => work() }, storage);
    await mkdir(join(projectsRoot, project.id), { recursive: true });
    const workspace = await service.ensureForSession(project.userId, session.id, true);
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: workspace.path, encoding: 'utf8' }).trim();
    assert.equal(realpathSync(top), realpathSync(workspace.path));
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: parent, encoding: 'utf8' }).trim(), 'platform');
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: workspace.path, encoding: 'utf8' }).trim(), 'main');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('Git import refuses a nested directory that belongs to a parent repository', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'project-git-guard-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: parent });
    const nested = join(parent, 'projects', 'project-1');
    await mkdir(nested, { recursive: true });
    const git = new GitService({ get: () => 10_000 });
    await assert.rejects(git.importRemote(nested, { remoteUrl: 'https://example.com/repo.git', token: '', branch: 'main' }), (error) => error.getResponse().code === 'PROJECT_GIT_ROOT_MISMATCH');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('Git import may omit name and derive it from the repository URL', () => {
  assert.equal(repositoryName('https://gitee.com/ilikeouheqiong/competition-app.git'), 'competition-app');
  assert.equal(repositoryName('https://example.com/team/demo/'), 'demo');
  const gitProject = Object.assign(new CreateProjectDto(), { source: 'git', repositoryUrl: 'https://example.com/team/demo.git' });
  assert.equal(validateSync(gitProject).length, 0);
  const blankProject = Object.assign(new CreateProjectDto(), { source: 'blank' });
  assert.ok(validateSync(blankProject).some((error) => error.property === 'name'));
});
