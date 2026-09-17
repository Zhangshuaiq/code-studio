import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ProjectRole = 'owner' | 'maintainer' | 'developer' | 'viewer';
export type ProjectCapability = 'read' | 'edit' | 'manage';

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  developer: 2,
  maintainer: 3,
  owner: 4,
};

@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  visibleWhere(userId: string) {
    return {
      OR: [{ userId }, { members: { some: { userId } } }],
    };
  }

  async requireProject(
    userId: string,
    projectId: string,
    capability: ProjectCapability = 'read',
    options: { allowImportFailed?: boolean } = {},
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: {
          where: { userId },
          select: { role: true },
        },
      },
    });
    if (!project) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: '项目不存在' });
    const role: ProjectRole | null =
      project.userId === userId
        ? 'owner'
        : normalizeRole(project.members[0]?.role);
    if (!role) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND_OR_INACCESSIBLE', message: '项目不存在或无权访问' });
    if (project.status.startsWith('deleting') || project.status === 'deletion_failed') throw new ConflictException({ code: 'PROJECT_DELETING', message: '项目正在删除或等待资源回收' });
    if (['import_queued', 'importing'].includes(project.status)) throw new ConflictException({ code: 'PROJECT_IMPORT_IN_PROGRESS', message: '项目代码正在导入，完成后才能操作工作区' });
    if (project.status === 'import_failed' && !options.allowImportFailed) throw new ConflictException({ code: 'PROJECT_IMPORT_FAILED', message: '项目代码导入失败，请先修正仓库配置并重新导入' });
    this.assertCapability(role, capability);
    return { ...project, accessRole: role };
  }

  async requireSession(
    userId: string,
    sessionId: string,
    capability: ProjectCapability = 'read',
    options: { allowProjectImport?: boolean } = {},
  ) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
      include: {
        user: true,
        project: {
          include: {
            members: {
              where: { userId },
              select: { role: true },
            },
            remote: true,
          },
        },
      },
    });
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND_OR_INACCESSIBLE', message: '会话不存在或不属于当前用户' });
    if (session.project.status.startsWith('deleting') || session.project.status === 'deletion_failed') throw new ConflictException({ code: 'PROJECT_DELETING', message: '项目正在删除或等待资源回收' });
    if (!options.allowProjectImport && ['import_queued', 'importing'].includes(session.project.status)) throw new ConflictException({ code: 'PROJECT_IMPORT_IN_PROGRESS', message: '项目代码正在导入，完成后才能操作工作区' });
    if (session.project.status === 'import_failed') throw new ConflictException({ code: 'PROJECT_IMPORT_FAILED', message: '项目代码导入失败，请先修正仓库配置并重新导入' });
    const role: ProjectRole | null =
      session.project.userId === userId
        ? 'owner'
        : normalizeRole(session.project.members[0]?.role);
    if (!role) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND_OR_INACCESSIBLE', message: '项目不存在或无权访问' });
    this.assertCapability(role, capability);
    return { ...session, accessRole: role };
  }

  assertCapability(role: ProjectRole, capability: ProjectCapability) {
    const required = capability === 'manage' ? 3 : capability === 'edit' ? 2 : 1;
    if (ROLE_RANK[role] < required) {
      const label = capability === 'manage' ? '管理' : capability === 'edit' ? '修改' : '查看';
      throw new ForbiddenException({
        code: 'PROJECT_CAPABILITY_DENIED',
        message: `当前项目角色无权${label}该项目`,
        capability,
      });
    }
  }
}

export function normalizeProjectRole(value: string): Exclude<ProjectRole, 'owner'> {
  if (value === 'maintainer' || value === 'viewer') return value;
  return 'developer';
}

function normalizeRole(value?: string): Exclude<ProjectRole, 'owner'> | null {
  return value ? normalizeProjectRole(value) : null;
}
