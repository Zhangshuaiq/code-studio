import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { AuthUser } from "../auth/jwt.strategy";
import { GitService } from "./git.service";
import { FilesService } from "../files/files.service";
import { PreviewService } from "../preview/preview.service";
import { PrismaService } from "../prisma/prisma.service";
import { SetRemoteDto } from "./dto/set-remote.dto";
import { GitSettingsService } from "./git-settings.service";
import { assertRepositoryUrl, repositoryHost } from "./git-url";
import { Audit } from "../audit/audit.decorator";
import {
  ProjectAccessService,
  ProjectCapability,
} from "../project-access/project-access.service";
import { PermissionsGuard } from "../auth/permissions.guard";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { PERMISSIONS } from "../auth/permissions";
import { ResolveConflictDto } from "./dto/resolve-conflict.dto";
import { BranchNameDto, PushDto } from "./dto/git-operation.dto";
import { WorkspaceLockInterceptor } from "../workspace/workspace-lock.interceptor";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.PROJECT_READ)
@UseInterceptors(WorkspaceLockInterceptor)
@Controller("sessions/:id/git")
export class GitController {
  constructor(
    private readonly git: GitService,
    private readonly files: FilesService,
    private readonly preview: PreviewService,
    private readonly prisma: PrismaService,
    private readonly settings: GitSettingsService,
    private readonly access: ProjectAccessService,
  ) {}

  /** 当前分支 */
  @Get("branch")
  async branch(@CurrentUser() user: AuthUser, @Param("id") sessionId: string) {
    const { root } = await this.files.projectVolume(user.id, sessionId);
    return { branch: await this.git.currentBranch(root) };
  }

  /** 分支列表 + 当前分支 */
  @Get("branches")
  async branches(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
  ) {
    const { root } = await this.files.projectVolume(user.id, sessionId);
    return this.git.branches(root);
  }

  /** 新建并切到分支 */
  @Post("branches")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  async createBranch(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
    @Body() body: BranchNameDto,
  ) {
    const { root } = await this.files.projectVolume(user.id, sessionId);
    const identity = await this.settings.resolveIdentity(user.id);
    await this.git.createBranch(root, (body.name || "").trim(), identity);
    await this.restartPreviewIfRunning(user.id, sessionId);
    return { ok: true };
  }

  /** 切换分支 */
  @Post("checkout")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  async checkout(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
    @Body() body: BranchNameDto,
  ) {
    await this.access.requireSession(user.id, sessionId, "edit");
    const { root } = await this.files.projectVolume(user.id, sessionId);
    try {
      const identity = await this.settings.resolveIdentity(user.id);
      await this.git.switchBranch(root, (body.name || "").trim(), identity);
    } catch {
      throw new BadRequestException({ code: 'GIT_BRANCH_CHECKOUT_FAILED', message: '无法切换分支，请确认工作区没有未提交冲突且分支仍然存在' });
    }
    await this.restartPreviewIfRunning(user.id, sessionId);
    return { ok: true };
  }

  /** 删除分支 */
  @Post("branches/:name/delete")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  async deleteBranch(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
    @Param("name") name: string,
  ) {
    await this.access.requireSession(user.id, sessionId, "edit");
    const { root } = await this.files.projectVolume(user.id, sessionId);
    try {
      await this.git.deleteBranch(root, name);
    } catch {
      throw new BadRequestException({ code: 'GIT_BRANCH_DELETE_FAILED', message: '无法删除分支，请确认它不是当前分支且尚未被其他工作区占用' });
    }
    return { ok: true };
  }

  /** 提交历史（每次生成 = 一次提交） */
  @Get("commits")
  async commits(@CurrentUser() user: AuthUser, @Param("id") sessionId: string) {
    const { root } = await this.files.projectVolume(user.id, sessionId);
    return this.git.log(root);
  }

  /** 某次提交的逐文件改动（含 before/after） */
  @Get("commits/:hash/diff")
  async diff(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
    @Param("hash") hash: string,
  ) {
    const { root } = await this.files.projectVolume(user.id, sessionId);
    return this.git.commitDiff(root, hash);
  }

  /** 回滚到某次提交（作为一次新提交），并在预览运行时自动重启 */
  @Post("rollback/:hash")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  async rollback(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
    @Param("hash") hash: string,
  ) {
    await this.access.requireSession(user.id, sessionId, "edit");
    const { root } = await this.files.projectVolume(user.id, sessionId);
    const identity = await this.settings.resolveIdentity(user.id);
    await this.git.rollback(root, hash, identity);
    const st = await this.preview.status(user.id, sessionId).catch(() => null);
    if (st && (st.status === "ready" || st.status === "starting")) {
      this.preview.start(user.id, sessionId).catch(() => undefined);
    }
    return { ok: true };
  }

  /** 读取该项目的远程仓库配置（不回传 token） */
  @Get("remote")
  async getRemote(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
  ) {
    const session = await this.access.requireSession(
      user.id,
      sessionId,
      "read",
    );
    const projectId = session.projectId;
    const r = await this.prisma.projectRemote.findUnique({
      where: { projectId },
    });
    if (!r) return null;
    const host = repositoryHost(r.remoteUrl);
    const settings = await this.settings.getSettings(user.id);
    return {
      remoteUrl: r.remoteUrl,
      branch: r.branch,
      host,
      hasCredential: settings.credentials.some((item) => item.host === host),
      identity: settings.identity,
      canManageRepository:
        session.accessRole === "owner" || session.accessRole === "maintainer",
      canImportRepository: session.accessRole === "owner",
    };
  }

  /** 保存项目级远程仓库配置；敏感凭据始终保存在当前用户自己的 Git 设置中。 */
  @Put("remote")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit("project.git-remote.update", "project")
  async setRemote(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
    @Body() dto: SetRemoteDto,
  ) {
    const projectId = await this.projectId(user.id, sessionId, "manage");
    const data = {
      remoteUrl: assertRepositoryUrl(dto.remoteUrl),
      branch: dto.branch?.trim() || "main",
    };
    await this.prisma.projectRemote.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
    return { ok: true };
  }

  /** 推送到远程仓库（force=true 强制覆盖远程） */
  @Post("push")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  async push(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
    @Body() body: PushDto = {},
  ) {
    await this.access.requireSession(
      user.id,
      sessionId,
      body.force ? "manage" : "edit",
    );
    const { root } = await this.files.projectVolume(user.id, sessionId);
    const projectId = await this.projectId(user.id, sessionId);
    const r = await this.prisma.projectRemote.findUnique({
      where: { projectId },
    });
    if (!r) throw new BadRequestException({ code: 'GIT_REMOTE_NOT_CONFIGURED', message: '尚未配置远程仓库' });
    const identity = await this.settings.resolveIdentity(user.id);
    const credential = await this.settings.credentialForRemote(
      user.id,
      r.remoteUrl,
    );
    // 在线编辑产生的未提交改动也由本次推送用户提交，避免漏推或错误归属。
    await this.git.commitAll(root, "手动改动", identity, true);
    // 推送当前分支到远程同名分支（分支工作流）
    const current = (await this.git.currentBranch(root)) || r.branch;
    try {
      const result = await this.git.push(root, {
        remoteUrl: r.remoteUrl,
        username: credential.username,
        token: credential.token,
        branch: current,
        force: !!body.force,
      });
      return { ok: true, ...result };
    } catch (err) {
      // git.push 已把 token 抹掉；把失败原因（及是否可强制推送）回给前端
      throw new BadRequestException({
        code: (err as { rejected?: boolean }).rejected ? 'GIT_PUSH_REJECTED' : 'GIT_PUSH_FAILED',
        message: (err as Error).message,
        rejected: !!(err as { rejected?: boolean }).rejected,
        statusCode: 400,
      });
    }
  }

  /** 本地分支相对项目默认远程分支的 ahead/behind 与冲突状态。 */
  @Get("sync-status")
  async syncStatus(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
  ) {
    const { root } = await this.files.projectVolume(user.id, sessionId);
    const projectId = await this.projectId(user.id, sessionId);
    const remote = await this.prisma.projectRemote.findUnique({
      where: { projectId },
    });
    if (!remote) return null;
    return this.git.remoteStatus(root, remote.branch);
  }

  /** 读取远端最新状态，不改动工作区文件。 */
  @Post("fetch")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  async fetchRemote(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
  ) {
    await this.access.requireSession(user.id, sessionId, "edit");
    const context = await this.remoteContext(user.id, sessionId);
    return this.git.fetchRemote(context.root, {
      remoteUrl: context.remote.remoteUrl,
      branch: context.remote.branch,
      ...context.credential,
    });
  }

  /** 合并项目默认远程分支；冲突时保留现场交给在线编辑器处理。 */
  @Post("sync")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit("project.git.sync", "project")
  async syncRemote(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
  ) {
    await this.access.requireSession(user.id, sessionId, "edit");
    const context = await this.remoteContext(user.id, sessionId);
    const identity = await this.settings.resolveIdentity(user.id);
    return this.git.syncRemote(context.root, {
      remoteUrl: context.remote.remoteUrl,
      branch: context.remote.branch,
      identity,
      ...context.credential,
    });
  }

  @Post("conflicts/continue")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  async continueMerge(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
  ) {
    await this.access.requireSession(user.id, sessionId, "edit");
    const context = await this.remoteContext(user.id, sessionId, false);
    const identity = await this.settings.resolveIdentity(user.id);
    return this.git.continueMerge(
      context.root,
      identity,
      context.remote.branch,
    );
  }

  /** 可视化合并器读取 Git stage 1/2/3（Base/Ours/Theirs）与可编辑结果。 */
  @Get("conflicts/detail")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  async conflictDetail(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
    @Query("path") path: string,
  ) {
    await this.access.requireSession(user.id, sessionId, "edit");
    const { root } = await this.files.projectVolume(user.id, sessionId);
    return this.git.conflictDetail(root, path);
  }

  /** 保存可视化合并结果并把单个文件标记为已解决。 */
  @Put("conflicts/resolve")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit("project.git.conflict.resolve", "project")
  async resolveConflict(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
    @Body() dto: ResolveConflictDto,
  ) {
    await this.access.requireSession(user.id, sessionId, "edit");
    const { root } = await this.files.projectVolume(user.id, sessionId);
    return this.git.resolveConflict(
      root,
      dto.path,
      dto.resolution,
      dto.content,
    );
  }

  @Post("conflicts/abort")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  async abortMerge(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
  ) {
    await this.access.requireSession(user.id, sessionId, "edit");
    const context = await this.remoteContext(user.id, sessionId, false);
    return this.git.abortMerge(context.root, context.remote.branch);
  }

  /** 仅允许项目创建者把尚无业务代码的主工作区初始化为远程仓库内容。 */
  @Post("import")
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit("project.git.import", "project")
  async importRemote(
    @CurrentUser() user: AuthUser,
    @Param("id") sessionId: string,
  ) {
    const session = await this.access.requireSession(
      user.id,
      sessionId,
      "manage",
    );
    if (session.accessRole !== "owner") {
      throw new BadRequestException({ code: 'GIT_IMPORT_OWNER_REQUIRED', message: '只有项目创建者可以初始化项目主仓库' });
    }
    const context = await this.remoteContext(user.id, sessionId);
    return this.git.importRemote(context.root, {
      remoteUrl: context.remote.remoteUrl,
      branch: context.remote.branch,
      ...context.credential,
    });
  }

  // 切分支/回滚后代码变了，预览在跑就重启使其生效
  private async restartPreviewIfRunning(userId: string, sessionId: string) {
    const st = await this.preview.status(userId, sessionId).catch(() => null);
    if (st && (st.status === "ready" || st.status === "starting")) {
      this.preview.start(userId, sessionId).catch(() => undefined);
    }
  }

  private async projectId(
    userId: string,
    sessionId: string,
    capability: ProjectCapability = "read",
  ): Promise<string> {
    const session = await this.access.requireSession(
      userId,
      sessionId,
      capability,
    );
    return session.projectId;
  }

  private async remoteContext(
    userId: string,
    sessionId: string,
    withCredential = true,
  ) {
    const { root } = await this.files.projectVolume(userId, sessionId);
    const projectId = await this.projectId(userId, sessionId);
    const remote = await this.prisma.projectRemote.findUnique({
      where: { projectId },
    });
    if (!remote) throw new BadRequestException({ code: 'GIT_REMOTE_NOT_CONFIGURED', message: '尚未配置远程仓库' });
    const credential = withCredential
      ? await this.settings.credentialForRemote(userId, remote.remoteUrl)
      : { username: undefined, token: "" };
    return { root, remote, credential };
  }
}
