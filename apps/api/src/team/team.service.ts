import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { AddMembersDto, CreateTeamDto, UpdateTeamDto } from './dto/team.dto';
import { PageQueryDto, pageArgs, pageResult } from '../common/dto/page-query.dto';

const PROJECT_CLEANUP_STATUSES = ['deleting', 'deleting_cleanup', 'deletion_failed'];

@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService) {}

  async listTeams(query: PageQueryDto) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.team.findMany({
      ...pageArgs(query),
      include: {
        _count: {
          select: { members: true, projects: true, datasources: true, deployTargets: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
      this.prisma.team.count(),
    ]);
    const cleanupCounts = items.length ? await this.prisma.project.groupBy({
      by: ['teamId'],
      where: { teamId: { in: items.map((team) => team.id) }, status: { in: PROJECT_CLEANUP_STATUSES } },
      _count: { _all: true },
    }) : [];
    const cleanupByTeam = new Map(cleanupCounts.map((entry) => [entry.teamId, entry._count._all]));
    return pageResult(items.map((team) => ({
      ...team,
      projectCounts: {
        visible: team._count.projects - (cleanupByTeam.get(team.id) ?? 0),
        cleanup: cleanupByTeam.get(team.id) ?? 0,
      },
    })), total, query);
  }

  async getTeam(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: {
        members: { take: 500, select: { id: true, username: true, email: true } },
        projects: { where: { status: { notIn: PROJECT_CLEANUP_STATUSES } }, take: 500, select: { id: true, name: true } },
        datasources: { take: 500, select: { id: true, name: true, type: true } },
      },
    });
    if (!team) throw new NotFoundException({ code: 'TEAM_NOT_FOUND', message: '项目组不存在' });
    return team;
  }

  async createTeam(dto: CreateTeamDto, createdById?: string) {
    try {
      return await this.prisma.team.create({ data: { name: dto.name, description: dto.description, createdById } });
    } catch (error) {
      this.rethrowTeamConflict(error);
    }
  }

  async updateTeam(id: string, dto: UpdateTeamDto) {
    await this.getTeam(id); // 存在性检查
    try {
      return await this.prisma.team.update({ where: { id }, data: dto });
    } catch (error) {
      this.rethrowTeamConflict(error);
    }
  }

  async deleteTeam(id: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const team = await tx.team.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!team) throw new NotFoundException({ code: 'TEAM_NOT_FOUND', message: '项目组不存在' });
        const [projects, datasources, deployTargets, requirements, knowledgeFolders, knowledgeDocuments] = await Promise.all([
          tx.project.findMany({ where: { teamId: id, status: { notIn: PROJECT_CLEANUP_STATUSES } }, select: { id: true, name: true, status: true, deletionError: true } }),
          tx.datasource.findMany({ where: { teamId: id }, select: { id: true, name: true } }),
          tx.deployTarget.findMany({ where: { teamId: id }, select: { id: true, name: true } }),
          tx.requirement.findMany({ where: { teamId: id }, select: { id: true, title: true } }),
          tx.knowledgeFolder.findMany({ where: { teamId: id }, select: { id: true, name: true, parentId: true } }),
          tx.knowledgeDocument.findMany({ where: { teamId: id }, select: { id: true, title: true } }),
        ]);
        const blockers = {
          projects: projects.length,
          datasources: datasources.length,
          deployTargets: deployTargets.length,
          requirements: requirements.length,
          knowledgeFolders: 0,
          knowledgeDocuments: knowledgeDocuments.length,
        };
        if (Object.values(blockers).some((count) => count > 0)) {
          throw new ConflictException({
            code: 'TEAM_DELETE_BLOCKED',
            message: '项目组仍有关联资源，不能删除',
            blockers,
            blockerDetails: { projects, datasources, deployTargets, requirements, knowledgeFolders: [], knowledgeDocuments },
          });
        }
        // 没有知识文档时，文件夹只是空目录结构。按叶子到根删除，避免自引用外键限制。
        const remainingFolders = new Map(knowledgeFolders.map((folder) => [folder.id, folder]));
        while (remainingFolders.size) {
          const parentIds = new Set([...remainingFolders.values()].map((folder) => folder.parentId).filter(Boolean));
          const leaves = [...remainingFolders.keys()].filter((folderId) => !parentIds.has(folderId));
          if (!leaves.length) throw new ConflictException({ code: 'TEAM_KNOWLEDGE_FOLDER_CYCLE', message: '知识文件夹层级异常，不能删除项目组' });
          await tx.knowledgeFolder.deleteMany({ where: { id: { in: leaves } } });
          leaves.forEach((folderId) => remainingFolders.delete(folderId));
        }
        // 删除中的项目不是可用资源。保留其项目和回收状态，只解除项目组归属；
        // 项目清理 Worker 按项目 ID 继续重试，与项目组生命周期解耦。
        await tx.project.updateMany({
          where: { teamId: id, status: { in: PROJECT_CLEANUP_STATUSES } },
          data: { teamId: null },
        });
        await tx.team.delete({ where: { id } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.rethrowTeamConflict(error);
    }
    return { success: true };
  }

  async addMembers(id: string, dto: AddMembersDto) {
    await this.getTeam(id);
    const userIds = [...new Set(dto.userIds)];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true } });
    const found = new Set(users.map((user) => user.id));
    const missingUserIds = userIds.filter((userId) => !found.has(userId));
    if (missingUserIds.length) {
      throw new BadRequestException({ code: 'TEAM_MEMBER_INVALID', message: '包含不存在的用户', userIds: missingUserIds });
    }
    await this.prisma.team.update({
      where: { id },
      data: { members: { connect: userIds.map((uid) => ({ id: uid })) } },
    });
    return this.getTeam(id);
  }

  async removeMembers(id: string, dto: AddMembersDto) {
    const userIds = [...new Set(dto.userIds)];
    try {
      await this.prisma.$transaction(async (tx) => {
      const team = await tx.team.findUnique({ where: { id }, select: { id: true } });
      if (!team) throw new NotFoundException({ code: 'TEAM_NOT_FOUND', message: '项目组不存在' });
      const relational = await tx.datasource.findMany({
        where: { teamId: id, category: 'relational' },
        select: { id: true, name: true, approvers: { select: { id: true } } },
      });
      const removed = new Set(userIds);
      const blocked = relational.filter((datasource) => !datasource.approvers.some((approver) => !removed.has(approver.id)));
      if (blocked.length) {
        throw new ConflictException({
          code: 'TEAM_MEMBER_REMOVAL_BLOCKED',
          message: '移除这些成员会导致关系型数据源没有审批人',
          datasources: blocked.map((datasource) => ({ id: datasource.id, name: datasource.name })),
        });
      }
      const approverDatasources = relational.filter((datasource) => datasource.approvers.some((approver) => removed.has(approver.id)));
      await tx.team.update({ where: { id }, data: { members: { disconnect: userIds.map((uid) => ({ id: uid })) } } });
      await tx.projectMember.deleteMany({ where: { userId: { in: userIds }, project: { teamId: id } } });
      await tx.datasourceMember.deleteMany({ where: { userId: { in: userIds }, datasource: { teamId: id } } });
      for (const datasource of approverDatasources) {
        await tx.datasource.update({ where: { id: datasource.id }, data: { approvers: { disconnect: userIds.map((userId) => ({ id: userId })) } } });
      }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.rethrowTeamConflict(error);
    }
    return this.getTeam(id);
  }

  private rethrowTeamConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException({ code: 'TEAM_NAME_CONFLICT', message: '项目组名称已存在' });
      }
      if (error.code === 'P2034') {
        throw new ConflictException({ code: 'TEAM_CONCURRENT_MODIFICATION', message: '项目组数据已被并发修改，请刷新后重试' });
      }
    }
    throw error;
  }
}
