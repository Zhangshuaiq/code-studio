import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface StoredProjectLocation {
  id: string;
  userId: string;
  storageKey: string;
  storagePath: string;
  volumePath: string;
}

/** 数据库只保存逻辑位置；每个部署节点用本机挂载根目录解析真实路径。 */
@Injectable()
export class WorkspaceStorageService {
  readonly projectsRoot: string;
  readonly workspacesRoot: string;

  constructor(config: ConfigService) {
    this.projectsRoot = resolve(config.get<string>('SANDBOX_PROJECTS_ROOT', '.data/projects'));
    this.workspacesRoot = resolve(config.get<string>('SANDBOX_WORKSPACES_ROOT', '.data/workspaces'));
  }

  projectPath(project: StoredProjectLocation): string {
    if (project.storageKey !== 'primary' || project.storagePath !== project.id || !/^[a-zA-Z0-9_-]{1,128}$/.test(project.id)) {
      throw new BadRequestException('项目存储位置无效');
    }
    const path = join(this.projectsRoot, project.storagePath);
    this.assertSafeExisting(this.projectsRoot, path);
    return path;
  }

  userPath(project: StoredProjectLocation, userId: string): string {
    if (project.userId === userId) return this.projectPath(project);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) throw new BadRequestException('用户工作区标识无效');
    const path = join(this.workspacesRoot, project.id, userId);
    this.assertSafeExisting(this.workspacesRoot, path);
    return path;
  }

  /** 旧部署路径已失效时禁止建立空仓库，需先迁移真实文件。 */
  assertAvailable(project: StoredProjectLocation): string {
    const path = this.projectPath(project);
    if (!existsSync(path) && project.volumePath && resolve(project.volumePath) !== path) {
      throw new ConflictException('项目文件不在当前共享存储卷中，请先迁移文件；不会创建空仓库覆盖原项目');
    }
    return path;
  }

  assertUserWorkspaceAvailable(expectedPath: string, legacyPath: string | null): void {
    // 旧 worktree 可能包含尚未提交的改动，不能在新位置静默重新创建。
    if (legacyPath && !existsSync(expectedPath) && resolve(legacyPath) !== expectedPath) {
      throw new ConflictException('用户工作区仍位于旧部署路径，请先迁移 Git worktree；不会创建新工作区覆盖原有改动');
    }
  }

  assertInside(root: string, target: string): void {
    const rel = relative(root, resolve(target));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new BadRequestException('工作区路径超出共享存储范围');
  }

  private assertSafeExisting(root: string, target: string): void {
    if (!existsSync(target)) return;
    if (!existsSync(root)) throw new BadRequestException('工作区存储卷不可访问');
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    this.assertInside(realRoot, realTarget);
  }
}
