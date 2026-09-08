import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { promisify } from "util";
import { PrismaService } from "../prisma/prisma.service";
import { ProjectAccessService } from "../project-access/project-access.service";
import { DistributedWorkspaceLockService } from "./distributed-workspace-lock.service";

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
  ) {
    this.workspacesRoot = resolve(
      this.config.get<string>("SANDBOX_WORKSPACES_ROOT", ".data/workspaces"),
    );
    this.deploymentsRoot = resolve(
      this.config.get<string>("DEPLOY_WORKSPACES_ROOT", ".data/deployments"),
    );
  }

  /** 为当前用户创建/恢复独立 Git worktree；项目创建者沿用项目主工作区。 */
  async ensureForSession(
    userId: string,
    sessionId: string,
  ): Promise<UserWorkspace> {
    let session = await this.access.requireSession(userId, sessionId, "read");
    if (session.workspacePath && existsSync(session.workspacePath)) {
      const current = await this.currentBranch(session.workspacePath);
      const branch =
        current ||
        session.workspaceBranch ||
        session.project.remote?.branch ||
        "main";
      if (branch !== session.workspaceBranch) {
        await this.saveWorkspace(sessionId, session.workspacePath, branch);
      }
      return {
        path: resolve(session.workspacePath),
        branch,
        isolated: session.project.userId !== userId,
      };
    }

    return this.workspaceLock.runExclusive(`repository:${session.projectId}`, async () => {
    // 获取仓库锁后重新检查，另一个 Pod 可能已经创建好该 worktree。
    session = await this.access.requireSession(userId, sessionId, "read");
    if (session.workspacePath && existsSync(session.workspacePath)) {
      const current = await this.currentBranch(session.workspacePath);
      const branch = current || session.workspaceBranch || session.project.remote?.branch || "main";
      return { path: resolve(session.workspacePath), branch, isolated: session.project.userId !== userId };
    }
    const identity = await this.resolveIdentity(userId);
    const canonical = resolve(session.project.volumePath);
    const defaultBranch = session.project.remote?.branch || "main";
    const canonicalReady =
      existsSync(canonical) &&
      (await this.gitOk(canonical, ["rev-parse", "--is-inside-work-tree"]));
    if (session.accessRole !== "owner" && !canonicalReady) {
      throw new BadRequestException(
        "项目主工作区尚未初始化，请由项目创建者先打开项目或导入远程仓库",
      );
    }
    await this.ensureCanonicalRepo(canonical, defaultBranch, identity);

    if (session.project.userId === userId) {
      const branch = (await this.currentBranch(canonical)) || defaultBranch;
      await this.saveWorkspace(sessionId, canonical, branch);
      return { path: canonical, branch, isolated: false };
    }

    const desired = join(this.workspacesRoot, session.projectId, userId);
    const branch = userBranch(session.user.username, userId);
    if (!existsSync(join(desired, ".git"))) {
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
    await this.saveWorkspace(sessionId, desired, branch);
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
    const canonical = resolve(project.volumePath);
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
    if (!existsSync(join(target, ".git"))) {
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
      return target;
    });
  }

  /** 删除项目元数据前清理其全部 worktree 和源码目录。调用方必须先确认无运行资源。 */
  async removeProjectFiles(projectId: string, canonicalPath: string) {
    return this.workspaceLock.runExclusive(`repository:${projectId}`, async () => {
    const users = await this.prisma.session.findMany({ where: { projectId }, select: { userId: true } });
    const userIds = [...new Set(users.map((item) => item.userId))].sort();
    return this.withWorkspaceLocks(projectId, userIds, 0, () =>
      this.removeProjectFilesLocked(projectId, canonicalPath),
    );
    });
  }

  private async withWorkspaceLocks<T>(projectId: string, userIds: string[], index: number, task: () => Promise<T>): Promise<T> {
    if (index >= userIds.length) return task();
    return this.workspaceLock.runExclusive(`workspace:${projectId}:${userIds[index]}`, () =>
      this.withWorkspaceLocks(projectId, userIds, index + 1, task),
    );
  }

  private async removeProjectFilesLocked(projectId: string, canonicalPath: string) {
    const canonical = resolve(canonicalPath);
    const sessions = await this.prisma.session.findMany({
      where: { projectId },
      select: { workspacePath: true },
    });
    const isolated = [...new Set(sessions
      .map((item) => item.workspacePath && resolve(item.workspacePath))
      .filter((item): item is string => !!item && item !== canonical))];
    for (const path of isolated) {
      this.assertInside(this.workspacesRoot, path);
      if (existsSync(canonical)) {
        await this.git(canonical, ["worktree", "remove", "--force", path]).catch(() => undefined);
      }
      await rm(path, { recursive: true, force: true });
    }
    const deployRoot = resolve(this.deploymentsRoot, projectId);
    this.assertInside(this.deploymentsRoot, deployRoot);
    await rm(deployRoot, { recursive: true, force: true });
    const projectsRoot = resolve(this.config.get<string>("SANDBOX_PROJECTS_ROOT", ".data/projects"));
    this.assertInside(projectsRoot, canonical);
    await rm(canonical, { recursive: true, force: true });
  }

  private assertInside(root: string, target: string) {
    const relativePath = relative(resolve(root), resolve(target));
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new BadRequestException("拒绝清理工作区根目录或范围外路径");
    }
  }

  private async ensureCanonicalRepo(
    path: string,
    defaultBranch: string,
    identity: { name: string; email: string },
  ) {
    await mkdir(path, { recursive: true });
    if (!(await this.gitOk(path, ["rev-parse", "--is-inside-work-tree"]))) {
      await this.git(path, ["init", "-q", "-b", defaultBranch]);
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

  private async saveWorkspace(sessionId: string, path: string, branch: string) {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { workspacePath: path, workspaceBranch: branch },
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
