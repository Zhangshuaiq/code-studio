import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve, sep } from "path";
import type { GitIdentity } from "./git-settings.service";
import { redactDiagnosticText } from "../common/redact-diagnostic";
import { ConfigService } from "@nestjs/config";
import {
  assertNoSymlinkPath,
  editableRelativePath,
  WorkspaceQuotaError,
} from "../common/workspace-quota";

const exec = promisify(execFile);
// git 的空树对象哈希（用于首个提交与空树做 diff）
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_DIFF_FILES = 60;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_CONFLICT_BYTES = 512 * 1024;

const GITIGNORE = [
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

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  date: number; // unix 秒
  authorName: string;
  authorEmail: string;
}

export interface FileChange {
  path: string;
  before: string;
  after: string;
  kind: "added" | "modified" | "deleted";
}

export interface RemoteSyncStatus {
  branch: string;
  remoteBranch: string;
  ahead: number;
  behind: number;
  conflicts: string[];
  mergeInProgress: boolean;
  fetched: boolean;
}

export type ConflictResolution =
  "manual" | "ours" | "theirs" | "both" | "delete";

export interface ConflictVersion {
  exists: boolean;
  size: number;
  content: string | null;
}

export interface ConflictHunk {
  index: number;
  ours: string;
  theirs: string;
  base: string;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
  /** 默认“采用当前版本”结果中的 UTF-16 字符偏移，供 Monaco 精确定位。 */
  resultStart: number;
  resultEnd: number;
}

export interface ConflictDetail {
  path: string;
  conflictType:
    "content" | "both-added" | "deleted-by-us" | "deleted-by-them" | "other";
  fileType: "text" | "binary" | "too-large";
  base: ConflictVersion;
  ours: ConflictVersion;
  theirs: ConflictVersion;
  result: ConflictVersion;
  suggestions: {
    ours: string | null;
    theirs: string | null;
    both: string | null;
  };
  hunks: ConflictHunk[];
}

@Injectable()
export class GitService {
  private readonly logger = new Logger(GitService.name);

  constructor(private readonly config: ConfigService) {}

  private git(cwd: string, args: string[]) {
    return exec("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: Math.max(1_000, Number(this.config.get("GIT_COMMAND_TIMEOUT_MS", 10 * 60_000))),
      killSignal: "SIGKILL",
      // 认证失败时立即报错，不要交互式弹密码（避免挂起）
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  /** 确保项目卷是个 git 仓库（首次 init + 写 .gitignore）。 */
  async ensureRepo(
    cwd: string,
    identity: GitIdentity,
    initialBranch = "main",
  ): Promise<void> {
    try {
      await this.git(cwd, ["rev-parse", "--is-inside-work-tree"]);
      return; // 已是仓库
    } catch {
      /* 需要初始化 */
    }
    try {
      assertBranchName(initialBranch);
      await this.git(cwd, ["init", "-q", "-b", initialBranch]);
      await this.git(cwd, ["config", "commit.gpgsign", "false"]);
      await writeFile(join(cwd, ".gitignore"), GITIGNORE, "utf8");
      await this.git(cwd, ["add", ".gitignore"]);
      await this.commit(cwd, "初始化项目", identity);
    } catch (err) {
      this.logger.warn(`git 初始化失败 ${cwd}: ${err}`);
    }
  }

  /** 把当前改动提交为一次记录；无改动则跳过。返回是否提交 */
  async commitAll(
    cwd: string,
    message: string,
    identity: GitIdentity,
    strict = false,
  ): Promise<boolean> {
    try {
      await this.git(cwd, ["add", "-A"]);
      const { stdout } = await this.git(cwd, ["status", "--porcelain"]);
      if (!stdout.trim()) return false; // 无改动
      const msg = (message || "更新").slice(0, 200);
      await this.commit(cwd, msg, identity);
      return true;
    } catch (err) {
      this.logger.warn(`git 提交失败 ${cwd}: ${err}`);
      if (strict) throw err;
      return false;
    }
  }

  /** 分支列表 + 当前分支 */
  async branches(cwd: string): Promise<{ current: string; list: string[] }> {
    const current = await this.currentBranch(cwd);
    let list: string[] = [];
    try {
      const { stdout } = await this.git(cwd, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ]);
      list = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      /* 无提交时可能没有分支 */
    }
    return { current, list };
  }

  /** 只读工作树状态，供受控查询使用；不执行 add/commit/checkout。 */
  async workingTreeStatus(cwd: string): Promise<Array<{ status: string; path: string }>> {
    try {
      const { stdout } = await this.git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
      return stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, 500)
        .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
    } catch {
      return [];
    }
  }

  /** 新建并切到分支（从当前 HEAD） */
  async createBranch(
    cwd: string,
    name: string,
    identity: GitIdentity,
  ): Promise<void> {
    assertBranchName(name);
    await this.git(cwd, ["checkout", "-b", name]);
    // 未提交修改随 checkout -b 保留，必须在新分支上提交，不能污染来源分支。
    await this.commitPending(cwd, identity);
  }

  /** 切换分支（切前把未提交改动先提交，避免 checkout 失败/丢改动） */
  async switchBranch(
    cwd: string,
    name: string,
    identity: GitIdentity,
  ): Promise<void> {
    assertBranchName(name);
    await this.commitPending(cwd, identity);
    await this.git(cwd, ["checkout", name]);
  }

  /** 删除分支（不能删当前分支） */
  async deleteBranch(cwd: string, name: string): Promise<void> {
    assertBranchName(name);
    await this.git(cwd, ["branch", "-D", name]);
  }

  private async commitPending(
    cwd: string,
    identity: GitIdentity,
  ): Promise<void> {
    try {
      await this.git(cwd, ["add", "-A"]);
      const { stdout } = await this.git(cwd, ["status", "--porcelain"]);
      if (stdout.trim()) await this.commit(cwd, "手动改动", identity);
    } catch {
      /* 忽略 */
    }
  }

  /** 当前 HEAD 的 commit sha（用于部署镜像 tag） */
  async headSha(cwd: string): Promise<string> {
    try {
      return (await this.git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    } catch {
      return "";
    }
  }

  /** 当前所在分支 */
  async currentBranch(cwd: string): Promise<string> {
    try {
      const { stdout } = await this.git(cwd, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      return stdout.trim();
    } catch {
      return "";
    }
  }

  /** 提交历史（最新在前） */
  async log(cwd: string, limit = 100): Promise<Commit[]> {
    try {
      const { stdout } = await this.git(cwd, [
        "log",
        `-n`,
        String(limit),
        "--pretty=format:%H%x1f%h%x1f%s%x1f%ct%x1f%an%x1f%ae",
      ]);
      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, short, subject, ct, authorName, authorEmail] =
            line.split("\x1f");
          return {
            hash,
            short,
            subject,
            date: Number(ct) * 1000,
            authorName,
            authorEmail,
          };
        });
    } catch {
      return [];
    }
  }

  /** HEAD（最近一次提交）相对其父的改动 */
  async headDiff(cwd: string): Promise<FileChange[]> {
    try {
      const head = (await this.git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      return this.commitDiff(cwd, head);
    } catch {
      return [];
    }
  }

  /** 某次提交相对其父的逐文件改动（含 before/after，供前端 diff） */
  async commitDiff(cwd: string, hash: string): Promise<FileChange[]> {
    let parent: string | null = null;
    try {
      parent = (await this.git(cwd, ["rev-parse", `${hash}^`])).stdout.trim();
    } catch {
      parent = null; // 根提交
    }
    const base = parent ?? EMPTY_TREE;
    let nameStatus = "";
    try {
      nameStatus = (
        await this.git(cwd, ["diff", "--name-status", "-M", base, hash])
      ).stdout;
    } catch {
      return [];
    }
    const out: FileChange[] = [];
    for (const line of nameStatus.split("\n").filter(Boolean)) {
      if (out.length >= MAX_DIFF_FILES) break;
      const parts = line.split("\t");
      const code = parts[0][0]; // A/M/D/R
      const path = parts[parts.length - 1];
      if (path === ".gitignore") continue;
      const kind =
        code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      const before =
        kind === "added" || !parent
          ? ""
          : await this.showFile(cwd, parent, path);
      const after =
        kind === "deleted" ? "" : await this.showFile(cwd, hash, path);
      out.push({ path, before, after, kind });
    }
    return out;
  }

  /** 回滚：把工作区还原到某次提交的状态，并作为一次新提交（保留后续历史可追溯） */
  async rollback(
    cwd: string,
    hash: string,
    identity: GitIdentity,
  ): Promise<void> {
    // read-tree 设置索引为目标树 → 写回工作区 → 清掉多余(未被忽略的)文件 → 提交
    await this.git(cwd, ["read-tree", hash]);
    await this.git(cwd, ["checkout-index", "-f", "-q", "-a"]);
    await this.git(cwd, ["clean", "-f", "-d", "-q"]); // 不带 -x，保留 node_modules 等忽略项
    const short = hash.slice(0, 7);
    await this.git(cwd, ["add", "-A"]);
    const { stdout } = await this.git(cwd, ["status", "--porcelain"]);
    if (stdout.trim()) {
      await this.commit(cwd, `回滚到 ${short}`, identity);
    }
  }

  /**
   * 推送到远程仓库（HTTPS + token）。凭证只临时拼进 URL 用于这一次 push，
   * 不写进 git remote 配置，错误信息里也会把 token 抹掉。
   */
  async push(
    cwd: string,
    opts: {
      remoteUrl: string;
      username?: string;
      token: string;
      branch: string;
      force?: boolean;
    },
  ): Promise<{ branch: string; output: string }> {
    const branch = opts.branch || "main";
    const authed = injectCreds(opts.remoteUrl, opts.username, opts.token);
    assertBranchName(branch);
    let forceArgs: string[] = [];
    if (opts.force) {
      const forceRef = `refs/remotes/codegen-force/${branch}`;
      let expected = "";
      try {
        await this.git(cwd, [
          "fetch",
          "--no-tags",
          authed,
          `+refs/heads/${branch}:${forceRef}`,
        ]);
        expected = (await this.git(cwd, ["rev-parse", forceRef])).stdout.trim();
      } catch {
        // 远端分支不存在时 expected 留空，lease 只允许创建而不会覆盖未知提交。
      }
      forceArgs = [`--force-with-lease=refs/heads/${branch}:${expected}`];
    }
    const args = ["push", ...forceArgs, authed, `HEAD:refs/heads/${branch}`];
    try {
      const { stdout, stderr } = await this.git(cwd, args);
      return { branch, output: redact(stdout + stderr, opts.token) };
    } catch (err) {
      const msg = redact(
        (err as { stderr?: string; message?: string }).stderr ??
          (err as Error).message ??
          "推送失败",
        opts.token,
      );
      // 标记"远程超前被拒"，前端据此提示是否强制推送
      const rejected =
        /\brejected\b|non-fast-forward|fetch first|Updates were rejected/i.test(
          msg,
        );
      const e = new Error(msg) as Error & { rejected?: boolean };
      e.rejected = rejected;
      throw e;
    }
  }

  async fetchRemote(
    cwd: string,
    opts: {
      remoteUrl: string;
      username?: string;
      token: string;
      branch: string;
    },
  ): Promise<RemoteSyncStatus> {
    assertBranchName(opts.branch);
    const authed = injectCreds(opts.remoteUrl, opts.username, opts.token);
    const target = remoteTrackingRef(opts.branch);
    try {
      await this.git(cwd, [
        "fetch",
        "--no-tags",
        authed,
        `+refs/heads/${opts.branch}:${target}`,
      ]);
      return this.remoteStatus(cwd, opts.branch, true);
    } catch (err) {
      throw new BadRequestException({
        code: "GIT_FETCH_FAILED",
        message: redact(gitError(err, "拉取远程状态失败"), opts.token),
      });
    }
  }

  async detectDefaultBranch(
    cwd: string,
    opts: { remoteUrl: string; username?: string; token: string },
  ): Promise<string> {
    const authed = injectCreds(opts.remoteUrl, opts.username, opts.token);
    try {
      const { stdout } = await this.git(cwd, ["ls-remote", "--symref", authed, "HEAD"]);
      const branch = stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m)?.[1];
      if (!branch) throw new Error("远程仓库没有可识别的 HEAD 分支");
      assertBranchName(branch);
      return branch;
    } catch (error) {
      throw new BadRequestException({
        code: "GIT_DEFAULT_BRANCH_UNRESOLVED",
        message: redact(gitError(error, "无法识别远程默认分支，请手动填写分支名"), opts.token),
      });
    }
  }

  async remoteStatus(
    cwd: string,
    remoteBranch: string,
    fetched = false,
  ): Promise<RemoteSyncStatus> {
    assertBranchName(remoteBranch);
    const branch = await this.currentBranch(cwd);
    const conflicts = await this.conflicts(cwd);
    const mergeInProgress = await this.gitOk(cwd, [
      "rev-parse",
      "-q",
      "--verify",
      "MERGE_HEAD",
    ]);
    let ahead = 0;
    let behind = 0;
    const target = remoteTrackingRef(remoteBranch);
    if (await this.gitOk(cwd, ["rev-parse", "--verify", target])) {
      try {
        const output = (
          await this.git(cwd, [
            "rev-list",
            "--left-right",
            "--count",
            `HEAD...${target}`,
          ])
        ).stdout.trim();
        const [left, right] = output.split(/\s+/).map(Number);
        ahead = Number.isFinite(left) ? left : 0;
        behind = Number.isFinite(right) ? right : 0;
      } catch {
        // 尚无共同历史时保持 0，由同步操作返回明确错误。
      }
    }
    return {
      branch,
      remoteBranch,
      ahead,
      behind,
      conflicts,
      mergeInProgress,
      fetched,
    };
  }

  async syncRemote(
    cwd: string,
    opts: {
      remoteUrl: string;
      username?: string;
      token: string;
      branch: string;
      identity: GitIdentity;
    },
  ) {
    const existingConflicts = await this.conflicts(cwd);
    if (existingConflicts.length) {
      return {
        status: "conflict" as const,
        ...(await this.remoteStatus(cwd, opts.branch)),
        conflicts: existingConflicts,
      };
    }
    await this.commitAll(cwd, "同步前保存本地改动", opts.identity, true);
    await this.fetchRemote(cwd, opts);
    const target = remoteTrackingRef(opts.branch);
    try {
      await this.git(cwd, [
        ...identityConfig(opts.identity),
        "merge",
        "--no-edit",
        target,
      ]);
      return {
        status: "synced" as const,
        ...(await this.remoteStatus(cwd, opts.branch, true)),
      };
    } catch (err) {
      const conflicts = await this.conflicts(cwd);
      if (conflicts.length) {
        return {
          status: "conflict" as const,
          ...(await this.remoteStatus(cwd, opts.branch, true)),
          conflicts,
        };
      }
      throw new BadRequestException({
        code: "GIT_SYNC_FAILED",
        message: redact(gitError(err, "同步远程分支失败"), opts.token),
      });
    }
  }

  async continueMerge(
    cwd: string,
    identity: GitIdentity,
    remoteBranch: string,
  ) {
    if (
      !(await this.gitOk(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]))
    ) {
      throw new BadRequestException({ code: 'GIT_MERGE_NOT_IN_PROGRESS', message: '当前没有等待处理的合并冲突' });
    }
    await this.git(cwd, ["add", "-A"]);
    const remaining = await this.conflicts(cwd);
    if (remaining.length) {
      throw new BadRequestException({ code: 'GIT_CONFLICTS_REMAIN', message: `仍有未解决的冲突：${remaining.join('、')}`, conflicts: remaining });
    }
    await this.commit(cwd, `合并远程 ${remoteBranch} 并解决冲突`, identity);
    return this.remoteStatus(cwd, remoteBranch, true);
  }

  async abortMerge(cwd: string, remoteBranch: string) {
    if (await this.gitOk(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) {
      await this.git(cwd, ["merge", "--abort"]);
    }
    return this.remoteStatus(cwd, remoteBranch, true);
  }

  async importRemote(
    cwd: string,
    opts: {
      remoteUrl: string;
      username?: string;
      token: string;
      branch: string;
    },
  ) {
    const tracked = (await this.git(cwd, ["ls-files"])).stdout
      .split("\n")
      .map((item) => item.trim())
      .filter((item) => item && item !== ".gitignore");
    const untracked = (await this.git(cwd, ["status", "--porcelain"])).stdout
      .split("\n")
      .filter((line) => line.trim() && !line.endsWith(" .gitignore"));
    if (tracked.length || untracked.length) {
      throw new BadRequestException({ code: 'GIT_IMPORT_WORKSPACE_NOT_EMPTY', message: '当前工作区已经包含代码，不能执行远程仓库导入；请改用同步功能' });
    }
    await this.fetchRemote(cwd, opts);
    await this.git(cwd, [
      "checkout",
      "-B",
      opts.branch,
      remoteTrackingRef(opts.branch),
    ]);
    return this.remoteStatus(cwd, opts.branch, true);
  }

  async conflicts(cwd: string): Promise<string[]> {
    try {
      return (
        await this.git(cwd, ["diff", "--name-only", "--diff-filter=U"])
      ).stdout
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 读取 Git 索引中的 stage 1/2/3，并给可视化三方合并器提供安全的文本内容。 */
  async conflictDetail(cwd: string, path: string): Promise<ConflictDetail> {
    await this.assertUnresolvedConflict(cwd, path);
    const stages = await this.conflictStages(cwd, path);
    const [base, ours, theirs] = await Promise.all([
      this.conflictVersion(cwd, stages.get(1)),
      this.conflictVersion(cwd, stages.get(2)),
      this.conflictVersion(cwd, stages.get(3)),
    ]);
    const result = await this.workingVersion(cwd, path);
    const versions = [base, ours, theirs, result].filter((item) => item.exists);
    const tooLarge = versions.some((item) => item.size > MAX_CONFLICT_BYTES);
    const binary =
      !tooLarge &&
      versions.some((item) =>
        item.content === null ? false : isProbablyBinary(item.content),
      );
    const fileType: ConflictDetail["fileType"] = tooLarge
      ? "too-large"
      : binary
        ? "binary"
        : "text";

    // 工作区内容保留了 Git 已自动合并的非冲突区。仅移除冲突标记并选择对应侧，
    // 比直接使用完整 ours/theirs 更不容易丢掉自动合并结果。
    let suggestedOurs = ours.content;
    let suggestedTheirs = theirs.content;
    let suggestedBoth =
      ours.content !== null && theirs.content !== null
        ? joinBoth(ours.content, theirs.content)
        : null;
    let hunks: ConflictHunk[] = [];
    if (fileType === "text" && result.content?.includes("<<<<<<<")) {
      const parsed = parseConflictMarkers(result.content);
      suggestedOurs = parsed.ours;
      suggestedTheirs = parsed.theirs;
      suggestedBoth = parsed.both;
      hunks = parsed.hunks;
    }

    if (fileType !== "text") {
      for (const version of [base, ours, theirs, result])
        version.content = null;
      suggestedOurs = null;
      suggestedTheirs = null;
      suggestedBoth = null;
      hunks = [];
    }

    return {
      path,
      conflictType: conflictType(base.exists, ours.exists, theirs.exists),
      fileType,
      base,
      ours,
      theirs,
      result,
      suggestions: {
        ours: suggestedOurs,
        theirs: suggestedTheirs,
        both: suggestedBoth,
      },
      hunks,
    };
  }

  /** 写入/选择最终版本并 git add；每次只允许解决当前索引里真实存在的冲突文件。 */
  async resolveConflict(
    cwd: string,
    path: string,
    resolution: ConflictResolution,
    content?: string,
  ): Promise<{ path: string; resolved: true; remaining: string[] }> {
    await this.assertUnresolvedConflict(cwd, path);
    const stages = await this.conflictStages(cwd, path);

    try {
      if (resolution === "delete") {
        await this.removeConflictPath(cwd, path);
      } else if (resolution === "ours" || resolution === "theirs") {
        const stage = resolution === "ours" ? 2 : 3;
        if (!stages.has(stage)) {
          await this.removeConflictPath(cwd, path);
        } else {
          await this.git(cwd, ["checkout", `--${resolution}`, "--", path]);
          await this.git(cwd, ["add", "--", path]);
        }
      } else {
        const detail = await this.conflictDetail(cwd, path);
        if (detail.fileType !== "text") {
          throw new BadRequestException({
            code: detail.fileType === 'binary' ? 'GIT_CONFLICT_BINARY' : 'GIT_CONFLICT_TOO_LARGE',
            message: detail.fileType === 'binary'
              ? '二进制冲突只能选择当前版本、远端版本或删除文件'
              : '文件过大，不能在线合并；请选择当前版本、远端版本或删除文件',
          });
        }
        const next = resolution === "both" ? detail.suggestions.both : content;
        if (typeof next !== "string") {
          throw new BadRequestException({ code: 'GIT_CONFLICT_CONTENT_REQUIRED', message: '缺少合并后的文件内容' });
        }
        if (Buffer.byteLength(next, "utf8") > MAX_CONFLICT_BYTES) {
          throw new BadRequestException({ code: 'GIT_CONFLICT_RESULT_TOO_LARGE', message: '合并结果超过 512KB，不能在线保存' });
        }
        try {
          const normalized = editableRelativePath(cwd, path);
          await assertNoSymlinkPath(cwd, normalized);
        } catch (error) {
          if (error instanceof WorkspaceQuotaError) {
            throw new BadRequestException({
              code: `WORKSPACE_${error.code.toUpperCase()}`,
              message: error.message,
            });
          }
          throw error;
        }
        const target = safeConflictTarget(cwd, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, next, "utf8");
        await this.git(cwd, ["add", "--", path]);
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException({
        code: "GIT_CONFLICT_SAVE_FAILED",
        message: gitError(error, "保存冲突解决结果失败"),
      });
    }

    const remaining = await this.conflicts(cwd);
    if (remaining.includes(path)) {
      throw new BadRequestException({ code: 'GIT_CONFLICT_NOT_RESOLVED', message: 'Git 仍将该文件标记为未解决，请重新选择解决方式' });
    }
    return { path, resolved: true, remaining };
  }

  private async assertUnresolvedConflict(cwd: string, path: string) {
    if (!path || path.includes("\0"))
      throw new BadRequestException({ code: 'GIT_CONFLICT_PATH_REQUIRED', message: '缺少冲突文件路径' });
    safeConflictTarget(cwd, path);
    const conflicts = await this.conflicts(cwd);
    if (!conflicts.includes(path)) {
      throw new BadRequestException({ code: 'GIT_CONFLICT_NOT_FOUND', message: '该文件不是当前工作区中的未解决冲突' });
    }
  }

  private async conflictStages(cwd: string, path: string) {
    const stdout = (await this.git(cwd, ["ls-files", "-u", "-z", "--", path]))
      .stdout;
    const stages = new Map<number, { oid: string }>();
    for (const record of stdout.split("\0").filter(Boolean)) {
      const match = record.match(/^\d+ ([0-9a-f]+) ([123])\t/);
      if (match) stages.set(Number(match[2]), { oid: match[1] });
    }
    return stages;
  }

  private async conflictVersion(
    cwd: string,
    stage?: { oid: string },
  ): Promise<ConflictVersion> {
    if (!stage) return { exists: false, size: 0, content: null };
    const size = Number(
      (await this.git(cwd, ["cat-file", "-s", stage.oid])).stdout.trim(),
    );
    if (!Number.isFinite(size) || size > MAX_CONFLICT_BYTES) {
      return {
        exists: true,
        size: Number.isFinite(size) ? size : 0,
        content: null,
      };
    }
    const content = (await this.git(cwd, ["cat-file", "blob", stage.oid]))
      .stdout;
    return { exists: true, size, content };
  }

  private async workingVersion(
    cwd: string,
    path: string,
  ): Promise<ConflictVersion> {
    try {
      const normalized = editableRelativePath(cwd, path);
      await assertNoSymlinkPath(cwd, normalized);
      const buffer = await readFile(safeConflictTarget(cwd, path));
      return {
        exists: true,
        size: buffer.length,
        content:
          buffer.length <= MAX_CONFLICT_BYTES ? buffer.toString("utf8") : null,
      };
    } catch {
      return { exists: false, size: 0, content: null };
    }
  }

  private async removeConflictPath(cwd: string, path: string) {
    await this.git(cwd, ["rm", "-f", "--ignore-unmatch", "--", path]);
  }

  private async showFile(
    cwd: string,
    ref: string,
    path: string,
  ): Promise<string> {
    try {
      const { stdout } = await this.git(cwd, ["show", `${ref}:${path}`]);
      if (Buffer.byteLength(stdout, "utf8") > MAX_FILE_BYTES)
        return "（文件过大，省略）";
      return stdout;
    } catch {
      return "";
    }
  }

  /** 每次提交显式带当前操作者身份，避免共享工作区的本地 git config 串号。 */
  private commit(cwd: string, message: string, identity: GitIdentity) {
    return this.git(cwd, [
      ...identityConfig(identity),
      "commit",
      "-q",
      "-m",
      message,
    ]);
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

// 校验分支名，防注入/非法字符
function assertBranchName(name: string): void {
  if (
    !/^[A-Za-z0-9._\-/]{1,80}$/.test(name) ||
    /(^\/|\/$|\.\.|@\{)/.test(name)
  ) {
    throw new BadRequestException({ code: 'GIT_BRANCH_INVALID', message: '非法分支名' });
  }
}

// 把凭证拼进 https URL：始终 user:token@host（token 作密码）。
// 无用户名时用 x-access-token（GitHub 用法，用户名被忽略）；Gitee 需填真实用户名。
function injectCreds(
  url: string,
  username: string | undefined,
  token: string,
): string {
  if (!token) return url;
  const m = url.match(/^https:\/\/(.+)$/i);
  if (!m) return url; // 非 https 原样返回（ssh 等暂不处理）
  const user = username && username.trim() ? username.trim() : "x-access-token";
  return `https://${encodeURIComponent(user)}:${encodeURIComponent(token)}@${m[1]}`;
}

// 抹掉输出里的 token，避免泄漏
function redact(text: string, token: string): string {
  return redactDiagnosticText(text, [token]);
}

function identityConfig(identity: GitIdentity): string[] {
  return [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "-c",
    "commit.gpgsign=false",
  ];
}

function remoteTrackingRef(branch: string) {
  return `refs/remotes/codegen/${branch}`;
}

function gitError(err: unknown, fallback: string) {
  return (
    (err as { stderr?: string; message?: string }).stderr ??
    (err as Error)?.message ??
    fallback
  );
}

function safeConflictTarget(cwd: string, path: string) {
  const root = resolve(cwd);
  const target = resolve(root, path);
  if (target === root || !target.startsWith(root + sep)) {
    throw new BadRequestException({ code: 'GIT_CONFLICT_PATH_INVALID', message: '非法冲突文件路径' });
  }
  return target;
}

function conflictType(
  base: boolean,
  ours: boolean,
  theirs: boolean,
): ConflictDetail["conflictType"] {
  if (!base && ours && theirs) return "both-added";
  if (base && !ours && theirs) return "deleted-by-us";
  if (base && ours && !theirs) return "deleted-by-them";
  if (base && ours && theirs) return "content";
  return "other";
}

function isProbablyBinary(value: string) {
  const sample = value.slice(0, 8000);
  if (sample.includes("\0") || sample.includes("\ufffd")) return true;
  let controls = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.02;
}

function joinBoth(ours: string, theirs: string) {
  if (!ours) return theirs;
  if (!theirs) return ours;
  return `${ours}${ours.endsWith("\n") ? "" : "\n"}${theirs}`;
}

/** 拆分 Git 冲突标记，生成逐块 hunk 与三种干净结果。 */
function parseConflictMarkers(content: string): {
  ours: string;
  theirs: string;
  both: string;
  hunks: ConflictHunk[];
} {
  const lines = content.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const oursOutput: string[] = [];
  const theirsOutput: string[] = [];
  const bothOutput: string[] = [];
  const hunks: ConflictHunk[] = [];
  let oursLength = 0;
  let theirsLength = 0;
  let state: "normal" | "ours" | "base" | "theirs" = "normal";
  let ours: string[] = [];
  let base: string[] = [];
  let theirs: string[] = [];

  for (const line of lines) {
    if (state === "normal" && line.startsWith("<<<<<<< ")) {
      state = "ours";
      ours = [];
      base = [];
      theirs = [];
      continue;
    }
    if (state === "ours" && line.startsWith("||||||| ")) {
      state = "base";
      continue;
    }
    if ((state === "ours" || state === "base") && line.startsWith("=======")) {
      state = "theirs";
      continue;
    }
    if (state === "theirs" && line.startsWith(">>>>>>> ")) {
      const oursText = ours.join("");
      const theirsText = theirs.join("");
      const oursStart = oursLength;
      const theirsStart = theirsLength;
      oursOutput.push(oursText);
      theirsOutput.push(theirsText);
      bothOutput.push(joinBoth(oursText, theirsText));
      oursLength += oursText.length;
      theirsLength += theirsText.length;
      hunks.push({
        index: hunks.length,
        ours: oursText,
        theirs: theirsText,
        base: base.join(""),
        oursStart,
        oursEnd: oursLength,
        theirsStart,
        theirsEnd: theirsLength,
        resultStart: oursStart,
        resultEnd: oursLength,
      });
      state = "normal";
      continue;
    }
    if (state === "normal") {
      oursOutput.push(line);
      theirsOutput.push(line);
      bothOutput.push(line);
      oursLength += line.length;
      theirsLength += line.length;
    } else if (state === "ours") ours.push(line);
    else if (state === "base") base.push(line);
    else if (state === "theirs") theirs.push(line);
  }
  // 非标准/损坏标记不静默吞内容；保留原文让用户看见问题。
  if (state !== "normal") {
    return { ours: content, theirs: content, both: content, hunks: [] };
  }
  return {
    ours: oursOutput.join(""),
    theirs: theirsOutput.join(""),
    both: bothOutput.join(""),
    hunks,
  };
}
