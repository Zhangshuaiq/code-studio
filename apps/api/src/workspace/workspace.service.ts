import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { existsSync, realpathSync } from "fs";
import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { promisify } from "util";
import { PrismaService } from "../prisma/prisma.service";
import { ProjectAccessService } from "../project-access/project-access.service";
import { DistributedWorkspaceLockService } from "./distributed-workspace-lock.service";
import { WorkspaceStorageService, type StoredProjectLocation } from './workspace-storage.service';

const exec = promisify(execFile);
const WORKSPACE_GITIGNORE = [
  "node_modules/",
  "dist/",
  "build/",
  "target/",
  ".vite/",
  ".venv/",
  "__pycache__/",
  "*.pyc",
  ".aider*",
  ".DS_Store",
  "",
].join("\n");

export interface UserWorkspace {
  path: string;
  branch: string;
  isolated: boolean;
}

@Injectable()
export class WorkspaceService {
  private readonly workspacesRoot: string;
  private readonly deploymentsRoot: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly access: ProjectAccessService,
    private readonly workspaceLock: DistributedWorkspaceLockService,
    private readonly storage: WorkspaceStorageService,
  ) {
    this.workspacesRoot = resolve(
      this.config.get<string>("SANDBOX_WORKSPACES_ROOT", ".data/workspaces"),
    );
    this.deploymentsRoot = resolve(
      this.config.get<string>("DEPLOY_WORKSPACES_ROOT", ".data/deployments"),
    );
  }

  /** 为当前用户创建/恢复独立 Git worktree；项目创建者沿用项目主工作区。 */
  async existingProjectPath(project: StoredProjectLocation): Promise<string> {
    const path = this.storage.assertAvailable(project);
    if (!await this.isRepositoryRoot(path)) {
      throw new ConflictException('项目工作区不存在或不是 Git 仓库');
    }
    return path;
  }

  async ensureForSession(
    userId: string,
    sessionId: string,
    allowProjectImport = false,
  ): Promise<UserWorkspace> {
    let session = await this.access.requireSession(userId, sessionId, "read", { allowProjectImport });
    const logicalPath = this.storage.userPath(session.project, userId);
    if (session.project.status === 'migrating') {
      if (!await this.isRepositoryRoot(logicalPath)) throw new ConflictException({ code: 'PROJECT_MIGRATING', message: '项目迁移中，当前工作区暂不可读取' });
      return { path: logicalPath, branch: session.workspaceBranch || 'main', isolated: session.project.userId !== userId };
    }
    if (session.project.userId !== userId) this.storage.assertUserWorkspaceAvailable(logicalPath, session.workspacePath);
    if (await this.isRepositoryRoot(logicalPath)) {
      const current = await this.currentBranch(logicalPath);
      const branch =
        current ||
        session.workspaceBranch ||
        session.project.remote?.branch ||
        "main";
      if (branch !== session.workspaceBranch) {
        await this.saveWorkspace(sessionId, branch);
      }
      return {
        path: logicalPath,
        branch,
        isolated: session.project.userId !== userId,
      };
    }

    return this.workspaceLock.runExclusive(`repository:${session.projectId}`, async () => {
    // 获取仓库锁后重新检查，另一个 Pod 可能已经创建好该 worktree。
    session = await this.access.requireSession(userId, sessionId, "read", { allowProjectImport });
    const currentPath = this.storage.userPath(session.project, userId);
    if (session.project.userId !== userId) this.storage.assertUserWorkspaceAvailable(currentPath, session.workspacePath);
    if (await this.isRepositoryRoot(currentPath)) {
      const current = await this.currentBranch(currentPath);
      const branch = current || session.workspaceBranch || session.project.remote?.branch || "main";
      return { path: currentPath, branch, isolated: session.project.userId !== userId };
    }
    const identity = await this.resolveIdentity(userId);
    const canonical = this.storage.assertAvailable(session.project);
    const defaultBranch = session.project.remote?.branch || "main";
    const canonicalReady = await this.isRepositoryRoot(canonical);
    if (session.accessRole !== "owner" && !canonicalReady) {
      throw new BadRequestException(
        "项目主工作区尚未初始化，请由项目创建者先打开项目或导入远程仓库",
      );
    }
    await this.ensureCanonicalRepo(canonical, defaultBranch, identity);

    if (session.project.userId === userId) {
      const branch = (await this.currentBranch(canonical)) || defaultBranch;
      await this.saveWorkspace(sessionId, branch);
      return { path: canonical, branch, isolated: false };
    }

    const desired = this.storage.userPath(session.project, userId);
    const branch = userBranch(session.user.username, userId);
    if (!await this.isRepositoryRoot(desired)) {
      if (existsSync(desired)) {
        throw new BadRequestException(
          `用户工作区目录已存在但不是有效 Git worktree：${desired}`,
        );
      }
      await mkdir(dirname(desired), { recursive: true });
      await this.git(canonical, ["worktree", "prune"]);
      const branchExists = await this.gitOk(canonical, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      if (branchExists) {
        await this.git(canonical, ["worktree", "add", desired, branch]);
      } else {
        await this.git(canonical, [
          "worktree",
          "add",
          "-b",
          branch,
          desired,
          "HEAD",
        ]);
      }
    }
    if (!await this.isRepositoryRoot(desired)) throw new ConflictException('用户工作区不是独立 Git worktree，已停止操作');
    await this.saveWorkspace(sessionId, branch);
      return { path: desired, branch, isolated: true };
    });
  }

  /**
   * 部署专用 detached worktree。它不属于任何用户会话，因此切换发布分支
   * 不会改变开发者代码页；同一项目/环境复用目录以保留构建缓存。
   */
  async ensureForDeployment(
    projectId: string,
    environment: string,
    branch: string,
  ): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { remote: true, user: true },
    });
    if (!project) throw new NotFoundException("项目不存在");
    return this.workspaceLock.runExclusive(`repository:${projectId}`, async () => {
    const canonical = this.storage.assertAvailable(project);
    const identity = await this.resolveIdentity(project.userId);
    await this.ensureCanonicalRepo(
      canonical,
      project.remote?.branch || "main",
      identity,
    );
    const safeEnvironment = environment.replace(/[^a-z0-9_-]+/gi, "-");
    const target = join(this.deploymentsRoot, projectId, safeEnvironment);
    await mkdir(dirname(target), { recursive: true });
    await this.git(canonical, ["worktree", "prune"]);
    if (!await this.isRepositoryRoot(target)) {
      if (existsSync(target)) {
        throw new BadRequestException(
          `部署工作区目录已存在但不是有效 Git worktree：${target}`,
        );
      }
      await this.git(canonical, [
        "worktree",
        "add",
        "--detach",
        target,
        branch,
      ]);
    } else {
      await this.git(target, ["checkout", "--detach", branch]);
      await this.git(target, ["reset", "--hard", branch]);
    }
    if (!await this.isRepositoryRoot(target)) throw new ConflictException('部署工作区不是独立 Git worktree，已停止操作');
      return target;
    });
  }

  /** 删除项目元数据前清理其全部 worktree 和源码目录。调用方必须先确认无运行资源。 */
  async removeProjectFiles(project: StoredProjectLocation) {
    const projectId = project.id;
    return this.workspaceLock.runExclusive(`repository:${projectId}`, async () => {
    const users = await this.prisma.session.findMany({ where: { projectId }, select: { userId: true } });
    const userIds = [...new Set(users.map((item) => item.userId))].sort();
    return this.withWorkspaceLocks(projectId, userIds, 0, () =>
      this.removeProjectFilesLocked(project),
    );
    });
  }

  /** 管理员清除孤儿记录前的只读校验：任何仍存在的工作区都不能被当作“目录缺失”。 */
  async projectFilesMissing(project: StoredProjectLocation): Promise<boolean> {
    if (!existsSync(this.storage.projectsRoot)) return false;
    const canonical = this.storage.projectPath(project);
    if (existsSync(canonical) || (project.volumePath && existsSync(project.volumePath))) return false;
    const sessions = await this.prisma.session.findMany({ where: { projectId: project.id }, select: { userId: true, workspacePath: true } });
    if (sessions.some((session) => session.userId !== project.userId) && !existsSync(this.workspacesRoot)) return false;
    for (const session of sessions) {
      if (session.workspacePath && existsSync(session.workspacePath)) return false;
      if (session.userId !== project.userId && existsSync(this.storage.userPath(project, session.userId))) return false;
    }
    const deploymentPath = resolve(this.deploymentsRoot, project.id);
    this.storage.assertInside(this.deploymentsRoot, deploymentPath);
    return !existsSync(deploymentPath);
  }

  private async withWorkspaceLocks<T>(projectId: string, userIds: string[], index: number, task: () => Promise<T>): Promise<T> {
    if (index >= userIds.length) return task();
    return this.workspaceLock.runExclusive(`workspace:${projectId}:${userIds[index]}`, () =>
      this.withWorkspaceLocks(projectId, userIds, index + 1, task),
    );
  }

  private async removeProjectFilesLocked(project: StoredProjectLocation) {
    const projectId = project.id;
    const canonical = this.storage.assertAvailable(project);
    const sessions = await this.prisma.session.findMany({
      where: { projectId },
      select: { userId: true },
    });
    const isolated = [...new Set(sessions
      .map((item) => item.userId !== project.userId ? this.storage.userPath(project, item.userId) : null)
      .filter((item): item is string => !!item && item !== canonical))];
    for (const path of isolated) {
      this.storage.assertInside(this.workspacesRoot, path);
      if (existsSync(canonical)) {
        await this.git(canonical, ["worktree", "remove", "--force", path]).catch(() => undefined);
      }
      await rm(path, { recursive: true, force: true });
    }
    const deployRoot = resolve(this.deploymentsRoot, projectId);
    this.storage.assertInside(this.deploymentsRoot, deployRoot);
    await rm(deployRoot, { recursive: true, force: true });
    this.storage.assertInside(this.storage.projectsRoot, canonical);
    await rm(canonical, { recursive: true, force: true });
  }

  private async ensureCanonicalRepo(
    path: string,
    defaultBranch: string,
    identity: { name: string; email: string },
  ) {
    await mkdir(path, { recursive: true });
    if (!await this.isRepositoryRoot(path)) {
      if (existsSync(join(path, '.git')) || (await readdir(path)).length) {
        throw new ConflictException({ code: 'PROJECT_WORKSPACE_NOT_EMPTY', message: '项目目录存在文件但不是独立 Git 仓库，已停止初始化以保护现有文件' });
      }
      await this.git(path, ["init", "-q", "-b", defaultBranch]);
      if (!await this.isRepositoryRoot(path)) throw new ConflictException('项目 Git 仓库初始化失败，已停止操作');
      await writeFile(join(path, ".gitignore"), WORKSPACE_GITIGNORE, "utf8");
      await this.git(path, ["add", ".gitignore"]);
      await this.commit(path, "初始化项目", identity);
      return;
    }
    if (!(await this.gitOk(path, ["rev-parse", "--verify", "HEAD"]))) {
      await this.commit(path, "初始化项目", identity, true);
    }
  }

  private async resolveIdentity(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { gitProfile: true },
    });
    if (!user) throw new NotFoundException("用户不存在");
    return {
      name: user.gitProfile?.authorName || user.displayName || user.username,
      email:
        user.gitProfile?.authorEmail ||
        user.email ||
        `${safeLocalPart(user.username)}@users.codegen.local`,
    };
  }

  private commit(
    cwd: string,
    message: string,
    identity: { name: string; email: string },
    allowEmpty = false,
  ) {
    return this.git(cwd, [
      "-c",
      `user.name=${identity.name}`,
      "-c",
      `user.email=${identity.email}`,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      ...(allowEmpty ? ["--allow-empty"] : []),
      "-m",
      message,
    ]);
  }

  private async currentBranch(cwd: string) {
    try {
      return (
        await this.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
      ).stdout.trim();
    } catch {
      return "";
    }
  }

  private async saveWorkspace(sessionId: string, branch: string) {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { workspacePath: null, workspaceBranch: branch },
    });
  }

  private git(cwd: string, args: string[]) {
    return exec("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  private async gitOk(cwd: string, args: string[]) {
    try {
      await this.git(cwd, args);
      return true;
    } catch {
      return false;
    }
  }

  private async isRepositoryRoot(path: string): Promise<boolean> {
    if (!existsSync(path)) return false;
    try {
      const { stdout } = await this.git(path, ['rev-parse', '--show-toplevel']);
      return realpathSync(stdout.trim()) === realpathSync(path);
    } catch {
      return false;
    }
  }
}

function userBranch(username: string, userId: string) {
  const slug =
    username
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "user";
  return `users/${slug.slice(0, 32)}-${userId.slice(0, 8)}`;
}

function safeLocalPart(username: string) {
  return (
    username.toLowerCase().replace(/[^a-z0-9.!#$%&'*+/=?^_`{|}~-]/g, "-") ||
    "user"
  );
}
