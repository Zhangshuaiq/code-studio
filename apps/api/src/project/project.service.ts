import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join, resolve } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { SetProjectRepositoryDto } from './dto/set-project-repository.dto';
import { assertRepositoryUrl } from '../git/git-url';
import {
  normalizeProjectRole,
  ProjectAccessService,
} from '../project-access/project-access.service';
import { PageQueryDto, pageArgs, pageResult } from '../common/dto/page-query.dto';
import { WorkspaceService } from '../workspace/workspace.service';
import { GitService } from '../git/git.service';
import { GitSettingsService } from '../git/git-settings.service';

@Injectable()
export class ProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly access: ProjectAccessService,
    private readonly workspaces: WorkspaceService,
    private readonly git: GitService,
    private readonly gitSettings: GitSettingsService,
  ) {}

  async create(userId: string, dto: CreateProjectDto) {
    const source = dto.source ?? (dto.repositoryUrl ? 'git' : 'blank');
    if (source === 'git' && !dto.repositoryUrl) {
      throw new BadRequestException({ code: 'PROJECT_REPOSITORY_REQUIRED', message: '从 Git 导入项目时必须填写仓库地址' });
    }
    if (source === 'blank' && dto.repositoryUrl) {
      throw new BadRequestException({ code: 'PROJECT_SOURCE_CONFLICT', message: '创建空白项目时不能同时提交仓库地址' });
    }
    // 如果指定了 teamId，验证用户是否在该项目组
    if (dto.teamId) {
      const team = await this.prisma.team.findUnique({
        where: { id: dto.teamId },
        include: { members: { select: { id: true } } },
      });
      if (!team) {
        throw new NotFoundException('项目组不存在');
      }
      if (!team.members.some((m) => m.id === userId)) {
        throw new ForbiddenException('您不是该项目组成员');
      }
    }

    // 前端优先：默认 react-vite
    const language = dto.language ?? 'react-vite';
    const project = await this.prisma.project.create({
      data: {
        userId,
        name: dto.name,
        language,
        status: source === 'git' ? 'importing' : 'active',
        teamId: dto.teamId,
        // 占位路径，阶段 2 由 SandboxModule 落地真实卷路径
        volumePath: '',
        // 创建者自动授权（如果指定了项目组）
        ...(dto.teamId
          ? {
              members: {
                create: { userId },
              },
            }
          : {}),
        ...(source === 'git' && dto.repositoryUrl
          ? {
              remote: {
                create: {
                  remoteUrl: assertRepositoryUrl(dto.repositoryUrl),
                  branch: dto.defaultBranch?.trim() || 'main',
                },
              },
            }
          : {}),
      },
    });

    // 用项目 id 生成宿主机挂载路径（沙箱首次启动时由 SandboxService 创建目录）
    const projectsRoot = resolve(
      this.config.get<string>('SANDBOX_PROJECTS_ROOT', '.data/projects'),
    );
    const volumePath = join(projectsRoot, project.id);
    const ready = await this.prisma.project.update({
      where: { id: project.id },
      data: { volumePath },
    });
    if (source === 'blank') return ready;

    try {
      const session = await this.prisma.session.create({ data: { projectId: project.id, userId } });
      const workspace = await this.workspaces.ensureForSession(userId, session.id);
      const credential = await this.gitSettings.optionalCredentialForRemote(userId, dto.repositoryUrl!);
      const branch = dto.defaultBranch?.trim() || await this.git.detectDefaultBranch(workspace.path, {
        remoteUrl: assertRepositoryUrl(dto.repositoryUrl!),
        username: credential?.username,
        token: credential?.token || '',
      });
      await this.git.importRemote(workspace.path, {
        remoteUrl: assertRepositoryUrl(dto.repositoryUrl!),
        branch,
        username: credential?.username,
        token: credential?.token || '',
      });
      await this.prisma.$transaction([
        this.prisma.projectRemote.update({ where: { projectId: project.id }, data: { branch } }),
        this.prisma.session.update({ where: { id: session.id }, data: { workspaceBranch: branch } }),
        this.prisma.project.update({ where: { id: project.id }, data: { status: 'active' } }),
      ]);
      return this.prisma.project.findUniqueOrThrow({
        where: { id: project.id },
        include: {
          remote: { select: { remoteUrl: true, branch: true } },
          team: { select: { id: true, name: true } },
        },
      });
    } catch (error) {
      await this.workspaces.removeProjectFiles(project.id, volumePath).catch(() => undefined);
      await this.prisma.project.deleteMany({ where: { id: project.id } }).catch(() => undefined);
      if (
        error instanceof BadRequestException
        && (error.getResponse() as { code?: string }).code === 'GIT_DEFAULT_BRANCH_UNRESOLVED'
      ) {
        throw error;
      }
      throw new BadRequestException({
        code: 'PROJECT_GIT_IMPORT_FAILED',
        message: `Git 项目导入失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async findAll(userId: string, query: PageQueryDto) {
    // 用户可见的项目：自己创建的 OR 被授权的（通过 ProjectMember）
    const where = {
      ...this.access.visibleWhere(userId),
      status: { notIn: ['importing', 'deleting', 'deleting_cleanup', 'deletion_failed'] },
    };
    const [projects, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
      where: {
        ...where,
      },
      ...pageArgs(query),
      include: {
        team: { select: { id: true, name: true } },
        remote: { select: { remoteUrl: true, branch: true } },
        members: { where: { userId }, select: { role: true } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
      this.prisma.project.count({ where }),
    ]);
    return pageResult(projects.map((project) => ({
      ...project,
      accessRole:
        project.userId === userId ? 'owner' : project.members[0]?.role || 'viewer',
    })), total, query);
  }

  async findOne(userId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id,
        status: { notIn: ['importing', 'deleting', 'deleting_cleanup', 'deletion_failed'] },
        OR: [
          { userId }, // 创建人
          { members: { some: { userId } } }, // 被授权的成员
        ],
      },
      include: {
        sessions: { orderBy: { createdAt: 'desc' } },
        remote: { select: { remoteUrl: true, branch: true } },
        team: {
          select: {
            id: true,
            name: true,
            members: {
              select: { id: true, username: true, email: true },
            },
          },
        },
        members: {
          select: {
            role: true,
            user: { select: { id: true, username: true, email: true } },
          },
        },
      },
    });
    if (!project) {
      throw new NotFoundException('项目不存在或无权访问');
    }
    const ownMembership = project.members.find((item) => item.user.id === userId);
    return {
      ...project,
      accessRole:
        project.userId === userId ? 'owner' : ownMembership?.role || 'viewer',
    };
  }

  async update(userId: string, id: string, dto: UpdateProjectDto) {
    const project = await this.access.requireProject(userId, id, 'manage');
    if (project.status.startsWith('deleting')) throw new ConflictException('项目正在删除，不能继续修改');
    return this.prisma.project.update({ where: { id }, data: dto });
  }

  async remove(userId: string, id: string) {
    const project = await this.ensureOwner(userId, id);
    if (project.status === 'deleting_cleanup') {
      return { ok: true, status: 'deleting' };
    }
    const [activeTasks, activeSandboxes, activePreviews, deployment] = await Promise.all([
      this.prisma.task.count({ where: { session: { projectId: id }, status: { in: ['queued', 'running', 'cancelling'] } } }),
      this.prisma.sandboxInstance.count({ where: { session: { projectId: id }, status: { in: ['starting', 'running'] } } }),
      this.prisma.previewInstance.count({ where: { session: { projectId: id }, status: { in: ['starting', 'ready'] } } }),
      this.prisma.deployment.findUnique({ where: { projectId: id }, select: { status: true } }),
    ]);
    const blockers = [
      activeTasks ? `${activeTasks} 个生成任务` : null,
      activeSandboxes ? `${activeSandboxes} 个沙箱` : null,
      activePreviews ? `${activePreviews} 个预览` : null,
      deployment && ['building', 'running'].includes(deployment.status) ? `状态为 ${deployment.status} 的部署` : null,
    ].filter(Boolean);
    if (blockers.length) {
      throw new ConflictException({ code: 'PROJECT_DELETE_BLOCKED', message: `删除项目前必须先停止：${blockers.join('、')}`, blockers });
    }
    await this.prisma.project.update({
      where: { id },
      data: {
        status: 'deleting',
        deletionStartedAt: null,
        deletionNextAttemptAt: new Date(),
        deletionAttempts: 0,
        deletionError: null,
        deletionAcknowledgedAt: null,
        deletionAcknowledgedById: null,
        deletionAcknowledgedByName: null,
        deletionAcknowledgementNote: null,
      },
    });
    return { ok: true, status: 'deleting' };
  }

  async getRepository(userId: string, projectId: string) {
    await this.ensureAccess(userId, projectId);
    return this.prisma.projectRemote.findUnique({
      where: { projectId },
      select: { remoteUrl: true, branch: true, updatedAt: true },
    });
  }

  async setRepository(
    userId: string,
    projectId: string,
    dto: SetProjectRepositoryDto,
  ) {
    await this.access.requireProject(userId, projectId, 'manage');
    const data = {
      remoteUrl: assertRepositoryUrl(dto.remoteUrl),
      branch: dto.branch?.trim() || 'main',
    };
    return this.prisma.projectRemote.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
      select: { remoteUrl: true, branch: true, updatedAt: true },
    });
  }

  async removeRepository(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, 'manage');
    await this.prisma.projectRemote.deleteMany({ where: { projectId } });
    return { ok: true };
  }

  // 项目成员管理：添加成员（用户必须和项目同属一个项目组）
  async addMembers(
    userId: string,
    projectId: string,
    userIds: string[],
    role = 'developer',
  ) {
    await this.access.requireProject(userId, projectId, 'manage');
    const memberRole = this.memberRole(role);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project?.teamId) {
      throw new NotFoundException('该项目未关联项目组，无法添加成员');
    }

    // 验证所有用户都属于同一项目组
    const teamMembers = await this.prisma.user.findMany({
      where: {
        id: { in: userIds },
        teams: { some: { id: project.teamId } },
      },
      select: { id: true },
    });
    const validUserIds = teamMembers.map((u) => u.id);
    const invalidUserIds = userIds.filter((id) => !validUserIds.includes(id));
    if (invalidUserIds.length > 0) {
      throw new NotFoundException(
        `用户 ${invalidUserIds.join(', ')} 不属于该项目组`,
      );
    }

    // 添加成员（已存在则跳过）
    await this.prisma.$transaction(
      validUserIds.map((uid) =>
        this.prisma.projectMember.upsert({
          where: { projectId_userId: { projectId, userId: uid } },
          create: { projectId, userId: uid, role: memberRole },
          update: { role: memberRole },
        }),
      ),
    );

    return this.findOne(userId, projectId);
  }

  // 移除项目成员
  async removeMembers(userId: string, projectId: string, userIds: string[]) {
    await this.access.requireProject(userId, projectId, 'manage');
    await this.prisma.projectMember.deleteMany({
      where: { projectId, userId: { in: userIds } },
    });
    return this.findOne(userId, projectId);
  }

  async updateMemberRole(
    userId: string,
    projectId: string,
    memberUserId: string,
    role: string,
  ) {
    await this.access.requireProject(userId, projectId, 'manage');
    const memberRole = this.memberRole(role);
    const result = await this.prisma.projectMember.updateMany({
      where: { projectId, userId: memberUserId },
      data: { role: memberRole },
    });
    if (!result.count) throw new NotFoundException('项目成员不存在');
    return this.findOne(userId, projectId);
  }

  private async ensureOwner(userId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      select: { id: true, volumePath: true, status: true },
    });
    if (!project) {
      throw new NotFoundException('项目不存在');
    }
    return project;
  }

  private async ensureAccess(userId: string, id: string) {
    await this.access.requireProject(userId, id, 'read');
  }

  private memberRole(role: string) {
    if (!['maintainer', 'developer', 'viewer'].includes(role)) {
      throw new BadRequestException('项目成员角色不正确');
    }
    return normalizeProjectRole(role);
  }
}
