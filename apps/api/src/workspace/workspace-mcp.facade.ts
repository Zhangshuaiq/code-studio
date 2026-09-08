import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { GitService } from '../git/git.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import { isMcpReadablePath } from './mcp-file-policy';

@Injectable()
export class WorkspaceMcpFacade {
  private readonly projectsRoot: string;
  private readonly workspacesRoot: string;

  constructor(
    config: ConfigService,
    private readonly access: ProjectAccessService,
    private readonly git: GitService,
  ) {
    this.projectsRoot = resolve(config.get<string>('SANDBOX_PROJECTS_ROOT', '.data/projects'));
    this.workspacesRoot = resolve(config.get<string>('SANDBOX_WORKSPACES_ROOT', '.data/workspaces'));
  }

  async get(userId: string, sessionId: string) {
    const session = await this.access.requireSession(userId, sessionId, 'read');
    const path = this.existingPath(session, userId);
    return {
      sessionId: session.id,
      project: { id: session.project.id, name: session.project.name },
      accessRole: session.accessRole,
      initialized: !!path,
      isolated: session.project.userId !== userId,
      branch: path ? await this.git.currentBranch(path) : session.workspaceBranch,
      createdAt: session.createdAt,
    };
  }

  async gitStatus(userId: string, sessionId: string) {
    const { session, path } = await this.requireExisting(userId, sessionId);
    const [branches, headSha, changes, conflicts] = await Promise.all([
      this.git.branches(path),
      this.git.headSha(path),
      this.git.workingTreeStatus(path),
      this.git.conflicts(path),
    ]);
    return {
      sessionId,
      projectId: session.projectId,
      currentBranch: branches.current,
      branches: branches.list,
      headSha,
      changes,
      conflicts,
      truncated: changes.length >= 500,
    };
  }

  async gitLog(userId: string, sessionId: string, limit: number) {
    const { path } = await this.requireExisting(userId, sessionId);
    const commits = await this.git.log(path, limit);
    return {
      sessionId,
      commits: commits.map((commit) => ({
        hash: commit.hash,
        short: commit.short,
        subject: commit.subject,
        date: commit.date,
        authorName: commit.authorName,
      })),
    };
  }

  async gitCommitDiff(userId: string, sessionId: string, hash: string) {
    const { path } = await this.requireExisting(userId, sessionId);
    const files = await this.git.commitDiff(path, hash);
    return {
      sessionId,
      hash,
      files: files.filter((file) => isMcpReadablePath(file.path)),
      filtered: files.some((file) => !isMcpReadablePath(file.path)),
    };
  }

  async requireExisting(userId: string, sessionId: string) {
    const session = await this.access.requireSession(userId, sessionId, 'read');
    const path = this.existingPath(session, userId);
    if (!path) throw new NotFoundException({
      code: 'WORKSPACE_NOT_INITIALIZED',
      message: '当前用户工作区尚未初始化；只读 MCP 调用不会自动创建工作区',
    });
    return { session, path };
  }

  private existingPath(
    session: Awaited<ReturnType<ProjectAccessService['requireSession']>>,
    userId: string,
  ) {
    if (!session.workspacePath) return null;
    const path = resolve(session.workspacePath);
    const root = session.project.userId === userId ? this.projectsRoot : this.workspacesRoot;
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    if (!existsSync(path) || !existsSync(join(path, '.git'))) return null;
    try {
      const realRoot = realpathSync(root);
      const realPath = realpathSync(path);
      const realRel = relative(realRoot, realPath);
      if (!realRel || realRel.startsWith('..') || isAbsolute(realRel)) return null;
      return realPath;
    } catch {
      return null;
    }
  }
}
