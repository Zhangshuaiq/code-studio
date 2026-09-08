import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PageQueryDto, pageArgs, pageResult } from '../common/dto/page-query.dto';
import { WorkspaceService } from '../workspace/workspace.service';
import { DistributedWorkspaceLockService } from '../workspace/distributed-workspace-lock.service';
import { GitService } from '../git/git.service';
import { GitSettingsService } from '../git/git-settings.service';
import type { AuthUser } from '../auth/jwt.strategy';
import { AddRequirementProjectDto, CreateRequirementDto, RequirementQueryDto, SaveRequirementDocumentDto, UpdateRequirementDto, UpdateRequirementProjectDto, UpdateRequirementStageDto } from './dto/requirement.dto';

const STAGES = [
  { type: 'design', sortOrder: 1 },
  { type: 'development', sortOrder: 2 },
  { type: 'testing', sortOrder: 3 },
  { type: 'canary', sortOrder: 4 },
  { type: 'release', sortOrder: 5 },
] as const;
const WEIGHTS: Record<string, number> = { design: 15, development: 40, testing: 25, canary: 10, release: 10 };

@Injectable()
export class RequirementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspaceService,
    private readonly workspaceLock: DistributedWorkspaceLockService,
    private readonly git: GitService,
    private readonly gitSettings: GitSettingsService,
  ) {}

  async list(userId: string, query: RequirementQueryDto) {
    const where = { team: { members: { some: { id: userId } } }, ...(query.teamId ? { teamId: query.teamId } : {}), ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.requirement.findMany({ where, include: { team: { select: { id: true, name: true } }, owner: { select: userSelect }, stages: { orderBy: { sortOrder: 'asc' }, select: { type: true, status: true, progress: true, owner: { select: userSelect } } }, _count: { select: { projects: true, previews: true } } }, orderBy: { updatedAt: 'desc' }, ...pageArgs(query) }),
      this.prisma.requirement.count({ where }),
    ]);
    return pageResult(items, total, query);
  }

  async metadata(userId: string) {
    const teams = await this.prisma.team.findMany({
      where: { members: { some: { id: userId } } },
      select: {
        id: true,
        name: true,
        members: { select: userSelect, orderBy: { username: 'asc' } },
        projects: {
          where: { status: 'active', OR: [{ userId }, { members: { some: { userId } } }] },
          select: { id: true, name: true, language: true },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
    return { teams };
  }

  async detail(userId: string, id: string) {
    await this.requireVisible(userId, id);
    return this.prisma.requirement.findUniqueOrThrow({ where: { id }, include: { team: { select: { id: true, name: true, members: { select: userSelect } } }, owner: { select: userSelect }, createdBy: { select: userSelect }, stages: { orderBy: { sortOrder: 'asc' }, include: { owner: { select: userSelect } } }, projects: { include: { project: { select: { id: true, name: true, language: true } }, developer: { select: userSelect }, session: { select: { id: true, workspaceBranch: true } } } }, previews: { select: { id: true, sessionId: true, serviceKey: true, status: true, url: true, targetName: true, lastActiveAt: true } }, routeEndpoints: { where: { leaseExpiresAt: { gt: new Date() } }, orderBy: { serviceKey: 'asc' } }, activities: { take: 100, orderBy: { createdAt: 'desc' }, include: { actor: { select: userSelect } } } } });
  }

  async create(userId: string, input: CreateRequirementDto) {
    const title = input.title.trim();
    if (!title) throw new BadRequestException({ code: 'REQUIREMENT_TITLE_REQUIRED', message: '需求标题不能为空' });
    await this.requireTeamMember(userId, input.teamId);
    const ownerId = input.ownerId || userId;
    await this.requireTeamMember(ownerId, input.teamId);
    assertSchedule(input.plannedStartAt, input.plannedEndAt);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const requirementNo = createRequirementNo();
        return await this.prisma.$transaction(async (tx) => {
          const requirement = await tx.requirement.create({ data: { requirementNo, teamId: input.teamId, title, summary: input.summary?.trim() || null, ownerId, createdById: userId, plannedStartAt: asDate(input.plannedStartAt), plannedEndAt: asDate(input.plannedEndAt), stages: { create: STAGES.map((stage) => ({ ...stage, ownerId: stage.type === 'design' ? ownerId : null })) } } });
          await tx.requirementRevision.create({ data: { requirementId: requirement.id, version: 1, contentMarkdown: '', changeSummary: '创建需求', createdById: userId } });
          await tx.requirementActivity.create({ data: { requirementId: requirement.id, actorId: userId, action: 'requirement.created', detail: { requirementNo } } });
          return requirement;
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
        if (attempt === 2) throw new ConflictException({ code: 'REQUIREMENT_NUMBER_CONFLICT', message: '需求编号生成冲突，请重试' });
      }
    }
    throw new ConflictException({ code: 'REQUIREMENT_NUMBER_CONFLICT', message: '需求编号生成冲突，请重试' });
  }

  async update(user: AuthUser, id: string, input: UpdateRequirementDto) {
    const userId = user.id; const requirement = await this.requireOwner(user, id);
    const changesMetadata = input.title !== undefined || input.summary !== undefined || input.ownerId !== undefined || input.plannedStartAt !== undefined || input.plannedEndAt !== undefined;
    if (changesMetadata && ['completed', 'cancelled', 'archived'].includes(requirement.status)) throw new ConflictException({ code: 'REQUIREMENT_IMMUTABLE', message: '已完成、已取消或已归档的需求不能再修改基础信息' });
    if (input.ownerId) await this.requireTeamMember(input.ownerId, requirement.teamId);
    const title = input.title?.trim();
    if (input.title !== undefined && !title) throw new BadRequestException({ code: 'REQUIREMENT_TITLE_REQUIRED', message: '需求标题不能为空' });
    assertSchedule(input.plannedStartAt !== undefined ? input.plannedStartAt || undefined : asDateString(requirement.plannedStartAt), input.plannedEndAt !== undefined ? input.plannedEndAt || undefined : asDateString(requirement.plannedEndAt));
    if (input.status && input.status !== requirement.status) {
      const allowed: Record<string, string[]> = { draft: ['active', 'cancelled'], active: ['completed', 'cancelled'], completed: ['archived'], cancelled: ['archived'], archived: [] };
      if (!allowed[requirement.status]?.includes(input.status)) throw new ConflictException({ code: 'REQUIREMENT_STATUS_TRANSITION_INVALID', message: `需求不能从 ${requirement.status} 变更为 ${input.status}` });
    }
    if (input.status === 'completed') {
      const unfinished = await this.prisma.requirementStage.count({ where: { requirementId: id, status: { notIn: ['completed', 'skipped'] } } });
      if (unfinished) throw new ConflictException({ code: 'REQUIREMENT_PIPELINE_INCOMPLETE', message: '流水线仍有未完成阶段，不能直接完成需求' });
    }
    if (input.status === 'archived' && !['completed', 'cancelled'].includes(requirement.status)) throw new ConflictException({ code: 'REQUIREMENT_ARCHIVE_STATE_INVALID', message: '只有已完成或已取消的需求可以归档' });
    const data = {
      ...(input.title !== undefined ? { title: title! } : {}),
      ...(input.summary !== undefined ? { summary: input.summary.trim() || null } : {}),
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.plannedStartAt !== undefined ? { plannedStartAt: asDate(input.plannedStartAt) } : {}),
      ...(input.plannedEndAt !== undefined ? { plannedEndAt: asDate(input.plannedEndAt) } : {}),
    };
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${id}))`;
      if (input.status && ['completed', 'cancelled', 'archived'].includes(input.status)) {
        const activePreviews = await tx.previewInstance.count({ where: { requirementId: id, status: { in: ['starting', 'ready', 'failed'] } } });
        if (activePreviews) throw new ConflictException({ code: 'REQUIREMENT_ACTIVE_PREVIEWS_EXIST', message: '需求仍有未停止的预览，请先停止全部预览后再变更为终态' });
      }
      const result = await tx.requirement.updateMany({ where: { id, updatedAt: new Date(input.baseUpdatedAt) }, data });
      if (result.count !== 1) throw new ConflictException({ code: 'REQUIREMENT_VERSION_CONFLICT', message: '需求信息已被其他人修改，请刷新后重试' });
      if (input.status && ['completed', 'cancelled', 'archived'].includes(input.status)) {
        await tx.requirementRouteEndpoint.deleteMany({ where: { requirementId: id } });
      }
      if (input.status === 'completed') {
        await tx.requirementProject.updateMany({ where: { requirementId: id }, data: { status: 'completed' } });
      }
      await tx.requirementActivity.create({ data: { requirementId: id, actorId: userId, action: 'requirement.updated', detail: jsonDetail(input) } });
      return tx.requirement.findUniqueOrThrow({ where: { id } });
    });
  }

  async saveDocument(user: AuthUser, id: string, input: SaveRequirementDocumentDto) {
    const userId = user.id; const requirement = await this.requireOwner(user, id);
    if (!['draft', 'active'].includes(requirement.status)) throw new ConflictException({ code: 'REQUIREMENT_IMMUTABLE', message: '已结束需求的文档已冻结，不能继续保存新版本' });
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${id}))`;
      const mutable = await tx.requirement.count({ where: { id, ...(!isAdmin(user) ? { ownerId: userId } : {}), status: { in: ['draft', 'active'] } } });
      if (mutable !== 1) throw new ConflictException({ code: 'REQUIREMENT_STATE_CHANGED', message: '需求状态或负责人已变化，请刷新后重试' });
      const updated = await tx.requirement.updateMany({ where: { id, documentVersion: input.baseVersion }, data: { contentMarkdown: input.contentMarkdown, documentVersion: { increment: 1 } } });
      if (updated.count !== 1) throw new ConflictException({ code: 'REQUIREMENT_DOCUMENT_VERSION_CONFLICT', message: '需求文档已被其他人修改，请刷新后合并' });
      const version = input.baseVersion + 1;
      await tx.requirementRevision.create({ data: { requirementId: id, version, contentMarkdown: input.contentMarkdown, changeSummary: input.changeSummary?.trim() || null, createdById: userId } });
      await tx.requirementActivity.create({ data: { requirementId: id, actorId: userId, action: 'requirement.document.saved', detail: { version } } });
      return { id, documentVersion: version };
    });
  }

  async revisions(userId: string, id: string, query: PageQueryDto) {
    await this.requireVisible(userId, id);
    const where = { requirementId: id };
    const [items, total] = await this.prisma.$transaction([this.prisma.requirementRevision.findMany({ where, include: { createdBy: { select: userSelect } }, orderBy: { version: 'desc' }, ...pageArgs(query) }), this.prisma.requirementRevision.count({ where })]);
    return pageResult(items, total, query);
  }

  async updateStage(user: AuthUser, requirementId: string, stageId: string, input: UpdateRequirementStageDto) {
    const userId = user.id;
    const requirement = await this.requireVisible(userId, requirementId);
    const stage = await this.prisma.requirementStage.findFirst({ where: { id: stageId, requirementId } });
    if (!stage) throw new NotFoundException({ code: 'REQUIREMENT_STAGE_NOT_FOUND', message: '需求阶段不存在' });
    const isOwner = requirement.ownerId === userId || isAdmin(user);
    if (!isOwner && stage.ownerId !== userId) throw new ForbiddenException({ code: 'REQUIREMENT_STAGE_ACCESS_DENIED', message: '只有需求负责人或当前阶段负责人可以更新该阶段' });
    if (input.ownerId && !isOwner) throw new ForbiddenException({ code: 'REQUIREMENT_OWNER_REQUIRED', message: '只有需求负责人或平台管理员可以调整阶段负责人' });
    if (input.ownerId) await this.requireTeamMember(input.ownerId, requirement.teamId);
    if (['completed', 'cancelled', 'archived'].includes(requirement.status)) throw new ConflictException({ code: 'REQUIREMENT_STAGE_IMMUTABLE', message: '已完成、已取消或已归档的需求不能再更新阶段' });
    assertSchedule(input.plannedStartAt !== undefined ? input.plannedStartAt : asDateString(stage.plannedStartAt), input.plannedEndAt !== undefined ? input.plannedEndAt : asDateString(stage.plannedEndAt));
    if (input.status === 'blocked' && !input.blockedReason?.trim()) throw new BadRequestException({ code: 'REQUIREMENT_BLOCKED_REASON_REQUIRED', message: '阶段阻塞时必须填写阻塞原因' });
    if (input.status === 'skipped' && !isOwner) throw new ForbiddenException({ code: 'REQUIREMENT_STAGE_SKIP_OWNER_REQUIRED', message: '只有需求负责人或平台管理员可以跳过阶段' });
    if (input.status === 'skipped' && !input.transitionReason?.trim()) throw new BadRequestException({ code: 'REQUIREMENT_STAGE_SKIP_REASON_REQUIRED', message: '跳过阶段必须填写原因' });
    if (input.progress !== undefined && ['completed', 'skipped'].includes(stage.status) && !input.status) throw new ConflictException({ code: 'REQUIREMENT_STAGE_PROGRESS_IMMUTABLE', message: '已完成或已跳过阶段不能单独修改进度，请先执行阶段回退' });
    const resultingStatus = input.status || stage.status;
    if (input.progress !== undefined && resultingStatus === 'pending' && input.progress !== 0) throw new BadRequestException({ code: 'REQUIREMENT_STAGE_PROGRESS_INVALID', message: '待开始阶段的进度必须为 0' });
    if (input.progress === 100 && !['completed', 'skipped'].includes(resultingStatus)) throw new BadRequestException({ code: 'REQUIREMENT_STAGE_PROGRESS_INVALID', message: '只有完成或跳过的阶段进度可以达到 100%' });
    const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, blocked: 1, completed: 2, skipped: 2 };
    const isRollback = !!input.status && statusOrder[input.status] < statusOrder[stage.status];
    if (isRollback && !input.transitionReason?.trim()) throw new BadRequestException({ code: 'REQUIREMENT_STAGE_ROLLBACK_REASON_REQUIRED', message: '阶段回退必须填写原因' });
    if (input.status === 'in_progress' || input.status === 'completed' || input.status === 'skipped') {
      const predecessor = await this.prisma.requirementStage.findFirst({ where: { requirementId, sortOrder: stage.sortOrder - 1 } });
      if (predecessor && !['completed', 'skipped'].includes(predecessor.status)) throw new ConflictException({ code: 'REQUIREMENT_STAGE_PREDECESSOR_INCOMPLETE', message: '前一阶段尚未完成或跳过' });
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${requirementId}))`;
      const lockedRequirement = await tx.requirement.findUnique({ where: { id: requirementId }, select: { updatedAt: true } });
      const lockedStage = await tx.requirementStage.findUnique({ where: { id: stageId }, select: { updatedAt: true } });
      if (!lockedRequirement || !lockedStage || lockedRequirement.updatedAt.getTime() !== requirement.updatedAt.getTime() || lockedStage.updatedAt.getTime() !== stage.updatedAt.getTime()) throw new ConflictException({ code: 'REQUIREMENT_STAGE_VERSION_CONFLICT', message: '需求或阶段已被其他人修改，请刷新后重试' });
      if (input.status && ['completed', 'skipped'].includes(input.status)) {
        const remainingStages = await tx.requirementStage.count({ where: { requirementId, id: { not: stageId }, status: { notIn: ['completed', 'skipped'] } } });
        if (!remainingStages) {
          const activePreviews = await tx.previewInstance.count({ where: { requirementId, status: { in: ['starting', 'ready', 'failed'] } } });
          if (activePreviews) throw new ConflictException({ code: 'REQUIREMENT_ACTIVE_PREVIEWS_EXIST', message: '完成最后阶段前必须先停止该需求的全部预览（包括失败实例）' });
        }
      }
      await tx.requirementStage.update({ where: { id: stageId }, data: { ...(input.ownerId !== undefined ? { ownerId: input.ownerId || null } : {}), ...(input.descriptionMarkdown !== undefined ? { descriptionMarkdown: input.descriptionMarkdown } : {}), ...(input.status ? { status: input.status } : {}), ...(input.progress !== undefined ? { progress: input.progress } : {}), ...(['completed', 'skipped'].includes(input.status || '') ? { progress: 100, completedAt: now } : input.status === 'pending' ? { progress: 0, startedAt: null, completedAt: null } : input.status === 'in_progress' ? { progress: Math.min(input.progress ?? stage.progress, 99), completedAt: null } : input.status ? { completedAt: null } : {}), ...(input.status === 'in_progress' && !stage.startedAt ? { startedAt: now } : {}), ...(input.status ? { blockedReason: input.status === 'blocked' ? input.blockedReason!.trim() : null } : input.blockedReason !== undefined ? { blockedReason: input.blockedReason.trim() || null } : {}), ...(input.plannedStartAt !== undefined ? { plannedStartAt: asDate(input.plannedStartAt) } : {}), ...(input.plannedEndAt !== undefined ? { plannedEndAt: asDate(input.plannedEndAt) } : {}) } });
      if (isRollback) await tx.requirementStage.updateMany({ where: { requirementId, sortOrder: { gt: stage.sortOrder } }, data: { status: 'pending', progress: 0, blockedReason: null, startedAt: null, completedAt: null } });
      const stages = await tx.requirementStage.findMany({ where: { requirementId }, orderBy: { sortOrder: 'asc' } });
      const progress = stages.reduce((total, item) => total + (WEIGHTS[item.type] || 0) * item.progress / 100, 0);
      const active = stages.find((item) => !['completed', 'skipped'].includes(item.status)) ?? stages[stages.length - 1];
      const pipelineCompleted = stages.every((item) => ['completed', 'skipped'].includes(item.status));
      await tx.requirement.update({ where: { id: requirementId }, data: { progress: Math.round(progress), currentStage: active?.type || 'release', ...(pipelineCompleted ? { status: 'completed' } : requirement.status === 'draft' ? { status: 'active' } : {}) } });
      if (pipelineCompleted) {
        await tx.requirementRouteEndpoint.deleteMany({ where: { requirementId } });
        await tx.requirementProject.updateMany({ where: { requirementId }, data: { status: 'completed' } });
      }
      await tx.requirementActivity.create({ data: { requirementId, actorId: userId, action: 'requirement.stage.updated', detail: jsonDetail({ stage: stage.type, rollback: isRollback, resetSuccessors: isRollback, ...input }) } });
    });
    return this.detail(userId, requirementId);
  }

  async addProject(user: AuthUser, requirementId: string, input: AddRequirementProjectDto) {
    const userId = user.id; const requirement = await this.requireOwner(user, requirementId);
    if (!['draft', 'active'].includes(requirement.status)) throw new ConflictException({ code: 'REQUIREMENT_PROJECT_IMMUTABLE', message: '已结束需求不能新增关联项目' });
    const serviceKey = input.serviceKey.trim().toLowerCase();
    if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(serviceKey)) throw new BadRequestException({ code: 'REQUIREMENT_SERVICE_KEY_INVALID', message: '服务标识必须是 Kubernetes DNS label（小写字母、数字和连字符）' });
    const project = await this.prisma.project.findFirst({ where: { id: input.projectId, teamId: requirement.teamId, OR: [{ userId }, { members: { some: { userId } } }] }, select: { id: true } });
    if (!project) throw new ForbiddenException({ code: 'REQUIREMENT_PROJECT_ACCESS_DENIED', message: '项目不存在、不属于需求项目组或当前用户无权管理' });
    if (input.developerId) {
      await this.requireTeamMember(input.developerId, requirement.teamId);
      const developerAccess = await this.prisma.project.findFirst({ where: { id: input.projectId, OR: [{ userId: input.developerId }, { members: { some: { userId: input.developerId, role: { in: ['developer', 'maintainer'] } } } }] }, select: { id: true } });
      if (!developerAccess) throw new BadRequestException({ code: 'REQUIREMENT_DEVELOPER_PROJECT_ACCESS_REQUIRED', message: '开发负责人必须拥有该项目的编辑权限' });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${requirementId}))`;
        const mutable = await tx.requirement.count({ where: { id: requirementId, ...(!isAdmin(user) ? { ownerId: userId } : {}), status: { in: ['draft', 'active'] } } });
        if (mutable !== 1) throw new ConflictException({ code: 'REQUIREMENT_STATE_CHANGED', message: '需求状态或负责人已变化，请刷新后重试' });
        const link = await tx.requirementProject.create({ data: { requirementId, projectId: input.projectId, serviceKey, developerId: input.developerId || null, changeRequired: input.changeRequired ?? true } });
        await tx.requirementActivity.create({ data: { requirementId, actorId: userId, action: 'requirement.project.added', detail: { projectId: input.projectId, serviceKey, developerId: input.developerId, changeRequired: input.changeRequired ?? true } } });
        return link;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'REQUIREMENT_PROJECT_CONFLICT', message: '该项目或服务标识已经关联当前需求' });
      throw error;
    }
  }

  async removeProject(user: AuthUser, requirementId: string, linkId: string) {
    const userId = user.id; const requirement = await this.requireOwner(user, requirementId);
    if (!['draft', 'active'].includes(requirement.status)) throw new ConflictException({ code: 'REQUIREMENT_PROJECT_IMMUTABLE', message: '已结束需求不能解除关联项目' });
    const link = await this.prisma.requirementProject.findFirst({ where: { id: linkId, requirementId }, select: { id: true, projectId: true, serviceKey: true } });
    if (!link) throw new NotFoundException({ code: 'REQUIREMENT_PROJECT_NOT_FOUND', message: '需求关联项目不存在' });
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${requirementId}))`;
      const mutable = await tx.requirement.count({ where: { id: requirementId, ...(!isAdmin(user) ? { ownerId: userId } : {}), status: { in: ['draft', 'active'] } } });
      if (mutable !== 1) throw new ConflictException({ code: 'REQUIREMENT_STATE_CHANGED', message: '需求状态或负责人已变化，请刷新后重试' });
      const active = await tx.previewInstance.count({ where: { requirementId, serviceKey: link.serviceKey, status: { in: ['starting', 'ready'] } } });
      if (active) throw new ConflictException({ code: 'REQUIREMENT_PROJECT_PREVIEW_RUNNING', message: '请先停止该服务的需求预览再解除关联' });
      const removed = await tx.requirementProject.deleteMany({ where: { id: link.id, requirementId } });
      if (removed.count !== 1) throw new ConflictException({ code: 'REQUIREMENT_PROJECT_CHANGED', message: '关联项目已被其他人修改，请刷新后重试' });
      await tx.requirementActivity.create({ data: { requirementId, actorId: userId, action: 'requirement.project.removed', detail: { projectId: link.projectId, serviceKey: link.serviceKey } } });
    });
    return { ok: true };
  }

  async updateProject(user: AuthUser, requirementId: string, linkId: string, input: UpdateRequirementProjectDto) {
    const userId = user.id; const requirement = await this.requireOwner(user, requirementId);
    if (!['draft', 'active'].includes(requirement.status)) throw new ConflictException({ code: 'REQUIREMENT_PROJECT_IMMUTABLE', message: '当前需求状态不能修改关联项目' });
    const link = await this.prisma.requirementProject.findFirst({ where: { id: linkId, requirementId }, select: { id: true, projectId: true, serviceKey: true, branchName: true, sessionId: true, developerId: true, changeRequired: true } });
    if (!link) throw new NotFoundException({ code: 'REQUIREMENT_PROJECT_NOT_FOUND', message: '需求关联项目不存在' });
    if (link.branchName || link.sessionId) throw new ConflictException({ code: 'REQUIREMENT_PROJECT_BRANCH_EXISTS', message: '需求分支创建后不能调整开发负责人或改动范围' });
    if (input.developerId) {
      await this.requireTeamMember(input.developerId, requirement.teamId);
      const access = await this.prisma.project.findFirst({ where: { id: link.projectId, OR: [{ userId: input.developerId }, { members: { some: { userId: input.developerId, role: { in: ['developer', 'maintainer'] } } } }] }, select: { id: true } });
      if (!access) throw new BadRequestException({ code: 'REQUIREMENT_DEVELOPER_PROJECT_ACCESS_REQUIRED', message: '开发负责人必须拥有该项目的编辑权限' });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${requirementId}))`;
      const mutable = await tx.requirement.count({ where: { id: requirementId, ...(!isAdmin(user) ? { ownerId: userId } : {}), status: { in: ['draft', 'active'] } } });
      if (mutable !== 1) throw new ConflictException({ code: 'REQUIREMENT_STATE_CHANGED', message: '需求状态或负责人已变化，请刷新后重试' });
      const current = await tx.requirementProject.findFirst({ where: { id: link.id, requirementId }, select: { branchName: true, sessionId: true } });
      if (!current) throw new ConflictException({ code: 'REQUIREMENT_PROJECT_CHANGED', message: '关联项目已被其他人修改，请刷新后重试' });
      if (current.branchName || current.sessionId) throw new ConflictException({ code: 'REQUIREMENT_PROJECT_BRANCH_EXISTS', message: '需求分支创建后不能调整开发负责人或改动范围' });
      const updated = await tx.requirementProject.update({ where: { id: link.id }, data: { ...(input.developerId !== undefined ? { developerId: input.developerId || null } : {}), ...(input.changeRequired !== undefined ? { changeRequired: input.changeRequired } : {}) } });
      await tx.requirementActivity.create({ data: { requirementId, actorId: userId, action: 'requirement.project.updated', detail: jsonDetail({ serviceKey: link.serviceKey, before: { developerId: link.developerId, changeRequired: link.changeRequired }, after: input }) } });
      return updated;
    });
  }

  async createProjectBranch(userId: string, requirementId: string, linkId: string) {
    const requirement = await this.requireVisible(userId, requirementId);
    if (!['draft', 'active'].includes(requirement.status)) throw new ConflictException({ code: 'REQUIREMENT_BRANCH_IMMUTABLE', message: '只有草稿或进行中的需求可以创建开发分支' });
    const link = await this.prisma.requirementProject.findFirst({ where: { id: linkId, requirementId }, select: { id: true, projectId: true, developerId: true, branchName: true, sessionId: true, changeRequired: true, serviceKey: true } });
    if (!link) throw new NotFoundException({ code: 'REQUIREMENT_PROJECT_NOT_FOUND', message: '需求关联项目不存在' });
    if (!link.changeRequired) throw new ConflictException({ code: 'REQUIREMENT_PROJECT_NO_CHANGE', message: '无需改动的项目不创建开发分支' });
    if (link.developerId !== userId) throw new ForbiddenException({ code: 'REQUIREMENT_BRANCH_DEVELOPER_REQUIRED', message: '只能由该项目被指派的开发负责人创建需求分支' });
    if (link.branchName && link.sessionId) return { branchName: link.branchName, sessionId: link.sessionId };

    const session = await this.prisma.session.upsert({
      where: { projectId_userId: { projectId: link.projectId, userId } },
      create: { projectId: link.projectId, userId },
      update: {},
      select: { id: true },
    });
    const workspace = await this.workspaces.ensureForSession(userId, session.id);
    const branchName = requirementBranch(requirement.requirementNo, link.serviceKey);
    return this.workspaceLock.runExclusive(`workspace:${link.projectId}:${userId}`, async () => {
      const latest = await this.prisma.requirementProject.findUnique({ where: { id: link.id }, select: { branchName: true, sessionId: true, developerId: true, changeRequired: true, requirement: { select: { status: true } } } });
      if (latest?.branchName && latest.sessionId) return { branchName: latest.branchName, sessionId: latest.sessionId };
      if (!latest || latest.developerId !== userId || !latest.changeRequired || !['draft', 'active'].includes(latest.requirement.status)) throw new ConflictException({ code: 'REQUIREMENT_BRANCH_STATE_CHANGED', message: '需求、负责人或项目改动范围已变化，请刷新后重试' });
      const identity = await this.gitSettings.resolveIdentity(userId);
      const currentBranch = await this.git.currentBranch(workspace.path);
      if (currentBranch === branchName) throw new ConflictException({ code: 'REQUIREMENT_BRANCH_OWNERSHIP_UNVERIFIED', message: '工作区已位于同名分支，但需求关联中没有归属记录，不能自动认领' });
      if (currentBranch !== branchName) {
        try {
          await this.git.createBranch(workspace.path, branchName, identity);
        } catch {
          throw new ConflictException({ code: 'REQUIREMENT_BRANCH_CREATE_FAILED', message: '需求分支创建失败，可能存在同名分支或工作区包含冲突' });
        }
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${requirementId}))`;
        const claimed = await tx.requirementProject.updateMany({ where: { id: link.id, requirementId, developerId: userId, changeRequired: true, branchName: null, sessionId: null, requirement: { status: { in: ['draft', 'active'] } } }, data: { branchName, sessionId: session.id, status: 'developing' } });
        if (claimed.count !== 1) throw new ConflictException({ code: 'REQUIREMENT_BRANCH_STATE_CHANGED', message: '需求分支创建期间关联配置发生变化，请刷新后处理已创建的本地分支' });
        await tx.session.update({ where: { id: session.id }, data: { workspaceBranch: branchName } });
        await tx.requirementActivity.create({ data: { requirementId, actorId: userId, action: 'requirement.branch.created', detail: { projectId: link.projectId, serviceKey: link.serviceKey, branchName, sessionId: session.id } } });
      });
      return { branchName, sessionId: session.id };
    });
  }

  private async requireVisible(userId: string, id: string) {
    const row = await this.prisma.requirement.findFirst({ where: { id, team: { members: { some: { id: userId } } } } });
    if (!row) throw new NotFoundException({ code: 'REQUIREMENT_NOT_FOUND', message: '需求不存在或无权访问' });
    return row;
  }
  private async requireOwner(user: AuthUser, id: string) {
    const row = await this.requireVisible(user.id, id);
    if (row.ownerId !== user.id && !isAdmin(user)) throw new ForbiddenException({ code: 'REQUIREMENT_OWNER_REQUIRED', message: '只有需求负责人或平台管理员可以执行该操作' });
    return row;
  }
  private async requireTeamMember(userId: string, teamId: string) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, members: { some: { id: userId } } }, select: { id: true } });
    if (!team) throw new ForbiddenException({ code: 'REQUIREMENT_TEAM_ACCESS_DENIED', message: '用户不属于需求项目组' });
  }
}

const userSelect = { id: true, username: true, displayName: true } as const;
function asDate(value?: string | null) { return value ? new Date(value) : null; }
function asDateString(value?: Date | null) { return value?.toISOString(); }
function assertSchedule(start?: string, end?: string) { if (start && end && new Date(start) > new Date(end)) throw new BadRequestException({ code: 'REQUIREMENT_SCHEDULE_INVALID', message: '计划开始时间不能晚于计划结束时间' }); }
function jsonDetail(value: object): Prisma.InputJsonObject { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }
function createRequirementNo() { const date = new Date().toISOString().slice(0, 10).replace(/-/g, ''); return `REQ-${date}-${randomBytes(3).toString('hex').toUpperCase()}`; }
function requirementBranch(requirementNo: string, serviceKey: string) { return `feature/${requirementNo.toLowerCase()}-${serviceKey}`; }
function isAdmin(user: AuthUser) { return user.roles.includes('admin'); }
