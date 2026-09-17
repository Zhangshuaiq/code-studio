import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
} from '../auth/permissions';
import { PageQueryDto, pageArgs, pageResult } from '../common/dto/page-query.dto';
import { ProjectCleanupListQueryDto, ProjectImportListQueryDto } from './dto/admin.dto';
import type { AuthUser } from '../auth/jwt.strategy';

export interface CreateUserInput {
  username: string;
  email?: string;
  displayName?: string;
  password: string;
  roleIds?: string[];
}
export interface UpdateUserInput {
  email?: string | null;
  displayName?: string | null;
  status?: string;
  roleIds?: string[];
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- 用户 ----

  async listUsers(query: PageQueryDto) {
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
      ...pageArgs(query),
      orderBy: { createdAt: 'asc' },
      include: { roles: { select: { id: true, name: true } } },
    }),
      this.prisma.user.count(),
    ]);
    return pageResult(users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      displayName: u.displayName,
      status: u.status,
      source: u.source,
      createdAt: u.createdAt,
      roles: u.roles,
    })), total, query);
  }

  async createUser(input: CreateUserInput) {
    if (!input.username?.trim() || !input.password)
      throw new BadRequestException({ code: 'ADMIN_USER_CREDENTIALS_REQUIRED', message: '用户名和密码必填' });
    const dupe = await this.prisma.user.findFirst({
      where: {
        OR: [
          { username: input.username.trim() },
          ...(input.email ? [{ email: input.email.trim() }] : []),
        ],
      },
    });
    if (dupe) throw new ConflictException({ code: 'ADMIN_USER_IDENTITY_CONFLICT', message: '用户名或邮箱已存在' });
    const roleIds = [...new Set(input.roleIds ?? [])];
    await this.assertRoleIdsExist(roleIds);

    const passwordHash = await bcrypt.hash(input.password, 10);
    try {
      const user = await this.prisma.user.create({
        data: {
          username: input.username.trim(),
          email: input.email?.trim() || null,
          displayName: input.displayName?.trim() || null,
          passwordHash,
          source: 'local',
          roles: roleIds.length
            ? { connect: roleIds.map((id) => ({ id })) }
            : undefined,
        },
        include: { roles: { select: { id: true, name: true } } },
      });
      return this.pub(user);
    } catch (error) {
      this.rethrowAdminWriteConflict(error);
    }
  }

  async updateUser(actorId: string, id: string, input: UpdateUserInput) {
    if (id === actorId && input.status === 'disabled')
      throw new ForbiddenException({ code: 'ADMIN_SELF_DISABLE_FORBIDDEN', message: '不能停用自己' });

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const target = await tx.user.findUnique({ where: { id }, include: { roles: true } });
        if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '用户不存在' });
        const roleIds = input.roleIds === undefined ? undefined : [...new Set(input.roleIds)];
        if (roleIds !== undefined) await this.assertRoleIdsExist(roleIds, tx);
        const willBeAdmin = roleIds !== undefined
          ? await this.roleIdsIncludeAdmin(roleIds, tx)
          : target.roles.some((role) => role.name === 'admin');
        const willBeActive = input.status !== undefined ? input.status !== 'disabled' : target.status !== 'disabled';
        const wasActiveAdmin = target.roles.some((role) => role.name === 'admin') && target.status !== 'disabled';
        if (wasActiveAdmin && !(willBeAdmin && willBeActive)) await this.assertOtherActiveAdminExists(id, tx);
        return tx.user.update({
          where: { id },
          data: {
            email: input.email === undefined ? undefined : input.email?.trim() || null,
            displayName: input.displayName === undefined ? undefined : input.displayName?.trim() || null,
            status: input.status,
            roles: roleIds ? { set: roleIds.map((rid) => ({ id: rid })) } : undefined,
          },
          include: { roles: { select: { id: true, name: true } } },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return this.pub(user);
    } catch (error) {
      this.rethrowAdminWriteConflict(error);
    }
  }

  async resetPassword(id: string, password: string) {
    if (!password || password.length < 8)
      throw new BadRequestException({ code: 'ADMIN_PASSWORD_TOO_SHORT', message: '密码至少 8 位' });
    const exists = await this.prisma.user.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '用户不存在' });
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(password, 10) },
    });
    return { ok: true };
  }

  async deleteUser(actorId: string, id: string) {
    if (id === actorId) throw new ForbiddenException({ code: 'ADMIN_SELF_DELETE_FORBIDDEN', message: '不能删除自己' });
    try {
      await this.prisma.$transaction(async (tx) => {
        const target = await tx.user.findUnique({ where: { id }, include: { roles: true } });
        if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '用户不存在' });
        if (target.status !== 'disabled' && target.roles.some((role) => role.name === 'admin')) {
          await this.assertOtherActiveAdminExists(id, tx);
        }
        await tx.user.delete({ where: { id } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.rethrowAdminWriteConflict(error);
    }
    return { ok: true };
  }

  // ---- 角色 / 权限 ----

  async listRoles(query: PageQueryDto) {
    const [roles, total] = await this.prisma.$transaction([
      this.prisma.role.findMany({
      ...pageArgs(query),
      orderBy: [{ builtin: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { users: true } } },
    }),
      this.prisma.role.count(),
    ]);
    return pageResult(roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      builtin: r.builtin,
      userCount: r._count.users,
    })), total, query);
  }

  permissionCatalog() {
    return ALL_PERMISSIONS.map((key) => ({
      key,
      label: PERMISSION_LABELS[key] ?? key,
    }));
  }

  async listProjectCleanups(query: ProjectCleanupListQueryDto) {
    const where: Prisma.ProjectWhereInput = {
      status: query.status
        ? query.status
        : { in: ['deleting', 'deleting_cleanup', 'deletion_failed'] },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        ...pageArgs(query),
        orderBy: [{ status: 'asc' }, { deletionNextAttemptAt: 'asc' }],
        select: {
          id: true,
          name: true,
          status: true,
          deletionStartedAt: true,
          deletionNextAttemptAt: true,
          deletionAttempts: true,
          deletionError: true,
          deletionAcknowledgedAt: true,
          deletionAcknowledgedById: true,
          deletionAcknowledgedByName: true,
          deletionAcknowledgementNote: true,
          createdAt: true,
          user: { select: { id: true, username: true, displayName: true } },
          team: { select: { id: true, name: true } },
        },
      }),
      this.prisma.project.count({ where }),
    ]);
    return pageResult(items, total, query);
  }

  async retryProjectCleanup(id: string) {
    const result = await this.prisma.project.updateMany({
      where: { id, status: 'deletion_failed' },
      data: {
        status: 'deleting',
        deletionAttempts: 0,
        deletionError: null,
        deletionStartedAt: null,
        deletionNextAttemptAt: new Date(),
        deletionAcknowledgedAt: null,
        deletionAcknowledgedById: null,
        deletionAcknowledgedByName: null,
        deletionAcknowledgementNote: null,
      },
    });
    if (!result.count) throw new ConflictException({ code: 'PROJECT_CLEANUP_NOT_FAILED', message: '项目不处于资源回收失败状态' });
    return { ok: true, status: 'deleting' };
  }

  async acknowledgeProjectCleanup(actor: AuthUser, id: string, note: string) {
    const result = await this.prisma.project.updateMany({
      where: { id, status: 'deletion_failed' },
      data: {
        deletionAcknowledgedAt: new Date(),
        deletionAcknowledgedById: actor.id,
        deletionAcknowledgedByName: actor.username,
        deletionAcknowledgementNote: note.trim(),
      },
    });
    if (!result.count) throw new ConflictException({ code: 'PROJECT_CLEANUP_NOT_FAILED', message: '只能确认处于最终失败状态的回收任务' });
    return { ok: true };
  }

  async listProjectImports(query: ProjectImportListQueryDto) {
    const where: Prisma.ProjectWhereInput = {
      status: query.status
        ? query.status
        : { in: ['import_queued', 'importing', 'import_failed'] },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        ...pageArgs(query),
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          name: true,
          status: true,
          importStartedAt: true,
          importFinishedAt: true,
          importLeaseUntil: true,
          importAttempts: true,
          importError: true,
          createdAt: true,
          remote: { select: { remoteUrl: true, branch: true } },
          user: { select: { id: true, username: true, displayName: true } },
          team: { select: { id: true, name: true } },
        },
      }),
      this.prisma.project.count({ where }),
    ]);
    return pageResult(items, total, query);
  }

  async retryProjectImport(id: string) {
    const result = await this.prisma.project.updateMany({
      where: { id, status: 'import_failed', remote: { isNot: null } },
      data: {
        status: 'import_queued',
        importStartedAt: null,
        importFinishedAt: null,
        importLeaseUntil: null,
        importError: null,
      },
    });
    if (!result.count) throw new ConflictException({ code: 'PROJECT_IMPORT_RETRY_NOT_ALLOWED', message: '只有导入失败且保留仓库配置的项目可以重新排队' });
    return { ok: true, status: 'import_queued' };
  }

  async createRole(input: {
    name: string;
    description?: string;
    permissions: string[];
  }) {
    if (!input.name?.trim()) throw new BadRequestException({ code: 'ROLE_NAME_REQUIRED', message: '角色名必填' });
    const dupe = await this.prisma.role.findUnique({
      where: { name: input.name.trim() },
    });
    if (dupe) throw new ConflictException({ code: 'ROLE_NAME_CONFLICT', message: '角色名已存在' });
    try {
      return await this.prisma.role.create({
        data: {
          name: input.name.trim(),
          description: input.description?.trim() || null,
          permissions: this.validPerms(input.permissions),
          builtin: false,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'ROLE_NAME_CONFLICT', message: '角色名已存在' });
      }
      throw error;
    }
  }

  async updateRole(
    id: string,
    input: { description?: string; permissions?: string[] },
  ) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: '角色不存在' });
    if (role.builtin)
      throw new ForbiddenException({ code: 'BUILTIN_ROLE_IMMUTABLE', message: '内置角色不可编辑（权限由系统维护）' });
    return this.prisma.role.update({
      where: { id },
      data: {
        description: input.description?.trim(),
        permissions: input.permissions
          ? this.validPerms(input.permissions)
          : undefined,
      },
    });
  }

  async deleteRole(id: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: '角色不存在' });
    if (role.builtin) throw new ForbiddenException({ code: 'BUILTIN_ROLE_IMMUTABLE', message: '内置角色不可删除' });
    await this.prisma.role.delete({ where: { id } });
    return { ok: true };
  }

  // ---- helpers ----

  private pub(u: {
    id: string;
    username: string;
    email: string | null;
    displayName: string | null;
    status: string;
    source: string;
    createdAt: Date;
    roles: { id: string; name: string }[];
  }) {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      displayName: u.displayName,
      status: u.status,
      source: u.source,
      createdAt: u.createdAt,
      roles: u.roles,
    };
  }

  private validPerms(perms: string[]): string[] {
    const unique = [...new Set(perms)];
    const invalidPermissions = unique.filter((permission) => !ALL_PERMISSIONS.includes(permission as never));
    if (invalidPermissions.length) {
      throw new BadRequestException({ code: 'ROLE_PERMISSION_INVALID', message: `包含未知权限：${invalidPermissions.join('、')}`, permissions: invalidPermissions });
    }
    return unique;
  }

  private async assertRoleIdsExist(roleIds: string[], tx: Prisma.TransactionClient = this.prisma) {
    const uniqueIds = [...new Set(roleIds)];
    if (!uniqueIds.length) return;
    const roles = await tx.role.findMany({ where: { id: { in: uniqueIds } }, select: { id: true } });
    const found = new Set(roles.map((role) => role.id));
    const missingRoleIds = uniqueIds.filter((id) => !found.has(id));
    if (missingRoleIds.length) {
      throw new BadRequestException({ code: 'ROLE_ASSIGNMENT_INVALID', message: '包含不存在的角色', roleIds: missingRoleIds });
    }
  }

  private rethrowAdminWriteConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException({ code: 'ADMIN_USER_IDENTITY_CONFLICT', message: '用户名或邮箱已存在' });
      }
      if (error.code === 'P2034') {
        throw new ConflictException({ code: 'ADMIN_CONCURRENT_MODIFICATION', message: '管理数据已被并发修改，请刷新后重试' });
      }
    }
    throw error;
  }

  private async roleIdsIncludeAdmin(roleIds: string[], tx: Prisma.TransactionClient = this.prisma): Promise<boolean> {
    if (!roleIds.length) return false;
    const n = await tx.role.count({
      where: { id: { in: roleIds }, name: 'admin' },
    });
    return n > 0;
  }

  // 防锁死：确保除 excludeUserId 外仍有别的启用中的 admin
  private async assertOtherActiveAdminExists(excludeUserId: string, tx: Prisma.TransactionClient = this.prisma) {
    const others = await tx.user.count({
      where: {
        id: { not: excludeUserId },
        status: { not: 'disabled' },
        roles: { some: { name: 'admin' } },
      },
    });
    if (others === 0)
      throw new ConflictException({ code: 'ACTIVE_ADMIN_REQUIRED', message: '至少需保留一个启用中的管理员' });
  }
}
