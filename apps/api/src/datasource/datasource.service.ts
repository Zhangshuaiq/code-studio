import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { CreateDatasourceDto, DatasourceConfig, DatasourceListQueryDto, UpdateDatasourceDto } from './dto/datasource.dto';
import { pageArgs, pageResult } from '../common/dto/page-query.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class DatasourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async resolveForDeployment(userId: string, id: string, teamId: string | null) {
    const row = await this.prisma.datasource.findFirst({
      where: { id, ...(teamId ? { teamId } : {}), members: { some: { userId } } },
    });
    if (!row) throw new NotFoundException({ code: 'DATASOURCE_NOT_FOUND_OR_INACCESSIBLE', message: '部署数据源不存在、未授权或与项目组不一致' });
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      config: JSON.parse(this.crypto.decrypt(row.encryptedConfig)) as DatasourceConfig,
    };
  }

  // 根据用户所属项目组 + 显式授权过滤数据源
  async listDatasources(userId: string, query: DatasourceListQueryDto) {
    // 用户可见的数据源：被授权的（通过 DatasourceMember）
    const where = {
        members: { some: { userId } },
        ...(query.category ? { category: query.category } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.datasource.findMany({
      ...pageArgs(query),
      where,
      select: {
        id: true,
        teamId: true,
        name: true,
        type: true,
        category: true,
        summary: true,
        createdAt: true,
        updatedAt: true,
        team: { select: { id: true, name: true } },
        _count: { select: { members: true, approvers: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
      this.prisma.datasource.count({ where }),
    ]);
    return pageResult(items, total, query);
  }

  async getDatasource(id: string, userId: string) {
    const ds = await this.prisma.datasource.findFirst({
      where: {
        id,
        members: { some: { userId } }, // 必须被授权
      },
      include: {
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
          select: { user: { select: { id: true, username: true, email: true } } },
        },
        approvers: { select: { id: true, username: true, email: true, displayName: true } },
      },
    });
    if (!ds) throw new NotFoundException({ code: 'DATASOURCE_NOT_FOUND_OR_INACCESSIBLE', message: '数据源不存在或无权访问' });

    // 详情接口只回传非敏感连接信息，密码永不离开服务端。
    const config = JSON.parse(
      this.crypto.decrypt(ds.encryptedConfig),
    ) as DatasourceConfig;

    const { password: _password, ...publicConfig } = config;
    const { encryptedConfig: _encryptedConfig, ...safeDatasource } = ds;
    return { ...safeDatasource, config: publicConfig, hasPassword: Boolean(config.password) };
  }

  /** 不解密连接配置的最小摘要，供只读自动化边界使用。 */
  async getDatasourceSummary(id: string, userId: string) {
    const datasource = await this.prisma.datasource.findFirst({
      where: { id, members: { some: { userId } } },
      select: {
        id: true,
        name: true,
        type: true,
        category: true,
        summary: true,
        team: { select: { id: true, name: true } },
        createdAt: true,
        updatedAt: true,
        _count: { select: { members: true, approvers: true } },
      },
    });
    if (!datasource) throw new NotFoundException({
      code: 'DATASOURCE_NOT_FOUND_OR_INACCESSIBLE',
      message: '数据源不存在或无权访问',
    });
    return datasource;
  }

  async createDatasource(dto: CreateDatasourceDto, userId: string) {
    // 检查用户是否在该项目组
    const team = await this.prisma.team.findUnique({
      where: { id: dto.teamId },
      include: { members: { select: { id: true } } },
    });
    if (!team) throw new NotFoundException({ code: 'TEAM_NOT_FOUND', message: '项目组不存在' });
    if (!team.members.some((m) => m.id === userId)) {
      throw new ForbiddenException({ code: 'DATASOURCE_TEAM_ACCESS_DENIED', message: '无权在此项目组创建数据源' });
    }

    const category = ['mysql', 'postgresql'].includes(dto.type)
      ? 'relational'
      : 'nosql';
    const encryptedConfig = this.crypto.encrypt(JSON.stringify(dto.config));
    const summary = this.buildSummary(dto.type, dto.config);

    // 创建数据源并自动授权给创建者
    const datasource = await this.prisma.datasource.create({
      data: {
        teamId: dto.teamId,
        name: dto.name,
        type: dto.type,
        category,
        encryptedConfig,
        summary,
        members: {
          create: { userId }, // 创建者自动获得访问权限
        },
        approvers: { connect: { id: userId } },
      },
      include: {
        team: { select: { id: true, name: true } },
        _count: { select: { members: true, approvers: true } },
      },
    });

    const { encryptedConfig: _encryptedConfig, ...safeDatasource } = datasource;
    return safeDatasource;
  }

  async updateDatasource(
    id: string,
    dto: UpdateDatasourceDto,
    userId: string,
  ) {
    await this.getDatasource(id, userId); // 权限检查
    const data: Prisma.DatasourceUpdateInput = {};
    if (dto.name) data.name = dto.name;
    if (dto.config) {
      const ds = await this.prisma.datasource.findUnique({ where: { id } });
      const previous = JSON.parse(this.crypto.decrypt(ds!.encryptedConfig)) as DatasourceConfig;
      const config = {
        ...previous,
        ...dto.config,
        // 编辑表单留空表示保留已有密码，而不是把密码清空。
        password: dto.config.password?.length ? dto.config.password : previous.password,
      };
      data.encryptedConfig = this.crypto.encrypt(JSON.stringify(config));
      data.summary = this.buildSummary(ds!.type, config);
    }

    await this.prisma.datasource.update({ where: { id }, data });
    return this.getDatasource(id, userId);
  }

  async deleteDatasource(id: string, userId: string) {
    await this.getDatasource(id, userId); // 权限检查
    await this.prisma.datasource.delete({ where: { id } });
    return { success: true };
  }

  // 数据源成员管理：添加成员（用户必须和数据源同属一个项目组）
  async addMembers(userId: string, datasourceId: string, userIds: string[]) {
    // 先检查当前用户有权限操作该数据源
    const ds = await this.prisma.datasource.findFirst({
      where: {
        id: datasourceId,
        members: { some: { userId } },
      },
      select: { teamId: true },
    });
    if (!ds) {
      throw new NotFoundException({ code: 'DATASOURCE_NOT_FOUND_OR_INACCESSIBLE', message: '数据源不存在或无权访问' });
    }

    // 验证所有用户都属于同一项目组
    const teamMembers = await this.prisma.user.findMany({
      where: {
        id: { in: userIds },
        teams: { some: { id: ds.teamId } },
      },
      select: { id: true },
    });
    const validUserIds = teamMembers.map((u) => u.id);
    const invalidUserIds = userIds.filter((id) => !validUserIds.includes(id));
    if (invalidUserIds.length > 0) {
      throw new NotFoundException({
        code: 'DATASOURCE_MEMBER_INELIGIBLE',
        message: `部分用户不存在或不属于该项目组：${invalidUserIds.join(', ')}`,
        userIds: invalidUserIds,
      });
    }

    // 添加成员（已存在则跳过）
    await this.prisma.$transaction(
      validUserIds.map((uid) =>
        this.prisma.datasourceMember.upsert({
          where: { datasourceId_userId: { datasourceId, userId: uid } },
          create: { datasourceId, userId: uid },
          update: {},
        }),
      ),
    );

    return this.getDatasource(datasourceId, userId);
  }

  // 移除数据源成员
  async removeMembers(userId: string, datasourceId: string, userIds: string[]) {
    const ds = await this.prisma.datasource.findFirst({
      where: { id: datasourceId, members: { some: { userId } } },
      select: { category: true, approvers: { select: { id: true } } },
    });
    if (!ds) throw new NotFoundException({ code: 'DATASOURCE_NOT_FOUND_OR_INACCESSIBLE', message: '数据源不存在或无权访问' });
    if (userIds.includes(userId)) {
      throw new ForbiddenException({ code: 'DATASOURCE_SELF_REMOVAL_FORBIDDEN', message: '不能通过管理接口移除自己的数据源权限' });
    }
    const removed = new Set(userIds);
    if (ds.category === 'relational' && !ds.approvers.some((approver) => !removed.has(approver.id))) {
      throw new ForbiddenException({ code: 'DATASOURCE_APPROVER_MINIMUM_REQUIRED', message: '关系型数据源至少需要保留一名审批人' });
    }
    await this.prisma.$transaction([
      this.prisma.datasourceMember.deleteMany({ where: { datasourceId, userId: { in: userIds } } }),
      this.prisma.datasource.update({ where: { id: datasourceId }, data: { approvers: { disconnect: userIds.map((id) => ({ id })) } } }),
    ]);
    return this.getDatasource(datasourceId, userId);
  }

  async setApprovers(userId: string, datasourceId: string, userIds: string[]) {
    const ds = await this.prisma.datasource.findFirst({ where: { id: datasourceId, members: { some: { userId } } }, select: { teamId: true, category: true } });
    if (!ds) throw new NotFoundException({ code: 'DATASOURCE_NOT_FOUND_OR_INACCESSIBLE', message: '数据源不存在或无权访问' });
    const uniqueIds = [...new Set(userIds)];
    if (ds.category === 'relational' && !uniqueIds.length) throw new ForbiddenException({ code: 'DATASOURCE_APPROVER_MINIMUM_REQUIRED', message: '关系型数据源至少需要一名审批人' });
    const eligible = await this.prisma.user.findMany({ where: { id: { in: uniqueIds }, status: 'active', teams: { some: { id: ds.teamId } }, datasourceAccess: { some: { datasourceId } } }, select: { id: true } });
    if (eligible.length !== uniqueIds.length) throw new ForbiddenException({ code: 'DATASOURCE_APPROVER_INELIGIBLE', message: '审批人必须是当前项目组内已启用且已获得数据源权限的用户' });
    await this.prisma.datasource.update({ where: { id: datasourceId }, data: { approvers: { set: eligible } } });
    return this.getDatasource(datasourceId, userId);
  }

  private buildSummary(type: string, config: DatasourceConfig): string {
    const { host, port, database, db } = config;
    if (type === 'redis') {
      return `redis://${host}:${port}/${db ?? 0}`;
    }
    if (type === 'mongodb') {
      return `mongodb://${host}:${port}/${database ?? ''}`;
    }
    return `${type}://${host}:${port}/${database ?? ''}`;
  }
}
