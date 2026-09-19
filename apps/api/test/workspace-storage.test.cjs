const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { WorkspaceStorageService } = require('../dist/workspace/workspace-storage.service.js');

test('project and user workspaces resolve from logical storage coordinates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-storage-test-'));
  try {
    const projects = join(root, 'projects');
    const workspaces = join(root, 'workspaces');
    const config = { get: (key) => key === 'SANDBOX_PROJECTS_ROOT' ? projects : workspaces };
    const storage = new WorkspaceStorageService(config);
    const project = { id: 'project-1', userId: 'owner-1', storageKey: 'primary', storagePath: 'project-1', volumePath: '/old/container/project-1' };
    assert.equal(storage.projectPath(project), join(projects, 'project-1'));
    assert.equal(storage.userPath(project, 'owner-1'), join(projects, 'project-1'));
    assert.equal(storage.userPath(project, 'member-1'), join(workspaces, 'project-1', 'member-1'));
    assert.throws(() => storage.assertAvailable(project), /先迁移文件/);
    assert.throws(() => storage.assertUserWorkspaceAvailable(join(workspaces, 'project-1', 'member-1'), '/old/workspaces/project-1/member-1'), /先迁移 Git worktree/);
    await mkdir(join(projects, 'project-1'), { recursive: true });
    assert.equal(storage.assertAvailable(project), join(projects, 'project-1'));
    assert.throws(() => storage.projectPath({ ...project, storagePath: '../escape' }), /存储位置无效/);
    assert.throws(() => storage.userPath(project, '../escape'), /标识无效/);
    await symlink(root, join(projects, 'project-2'));
    assert.throws(() => storage.projectPath({ ...project, id: 'project-2', storagePath: 'project-2' }), /超出共享存储范围/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
