import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { AddMembersDto, CreateTeamDto, UpdateTeamDto } from './dto/team.dto';
import { PageQueryDto, pageArgs, pageResult } from '../common/dto/page-query.dto';

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
    return pageResult(items, total, query);
  }

  async getTeam(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: {
        members: { take: 500, select: { id: true, username: true, email: true } },
        projects: { take: 500, select: { id: true, name: true } },
        datasources: { take: 500, select: { id: true, name: true, type: true } },
      },
    });
    if (!team) throw new NotFoundException({ code: 'TEAM_NOT_FOUND', message: '项目组不存在' });
    return team;
  }

  async createTeam(dto: CreateTeamDto) {
    try {
      return await this.prisma.team.create({ data: { name: dto.name, description: dto.description } });
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
          select: { _count: { select: { projects: true, datasources: true, deployTargets: true } } },
        });
        if (!team) throw new NotFoundException({ code: 'TEAM_NOT_FOUND', message: '项目组不存在' });
        const blockers = {
          projects: team._count.projects,
          datasources: team._count.datasources,
          deployTargets: team._count.deployTargets,
        };
        if (Object.values(blockers).some((count) => count > 0)) {
          throw new ConflictException({ code: 'TEAM_DELETE_BLOCKED', message: '项目组仍关联项目、数据源或部署目标，不能删除', blockers });
        }
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
