import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { ProjectAccessService } from '../project-access/project-access.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { ModelConfigService } from '../model-config/model-config.service';

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly workspaces: WorkspaceService,
    private readonly models: ModelConfigService,
  ) {}

  async create(userId: string, dto: CreateSessionDto) {
    const project = await this.access.requireProject(userId, dto.projectId, 'read');
    const existing = await this.prisma.session.findUnique({
      where: { projectId_userId: { projectId: dto.projectId, userId } },
    });
    if (project.status === 'migrating') {
      if (!existing) throw new ConflictException({ code: 'PROJECT_MIGRATING', message: '项目迁移中，不能新建工作区' });
      return this.publicSession(existing, userId);
    }
    const session =
      existing ??
      (await this.prisma.session.create({
        data: { projectId: dto.projectId, userId },
      }));
    await this.workspaces.ensureForSession(userId, session.id);
    const ready = await this.prisma.session.findUnique({ where: { id: session.id } });
    return ready ? this.publicSession(ready, userId) : null;
  }

  async update(userId: string, id: string, dto: UpdateSessionDto) {
    await this.access.requireSession(userId, id, 'edit');
    // 校验模型配置属于本人（传了才校验）
    if (dto.modelConfigId) {
      const cfg = await this.prisma.modelConfig.findFirst({
        where: { id: dto.modelConfigId, userId },
        select: { id: true },
      });
      if (!cfg) throw new NotFoundException('模型配置不存在');
    }
    const modelConfigId = dto.modelConfigId;
    const modelName = dto.modelName;
    if (modelName) {
      if (!modelConfigId) throw new BadRequestException('请选择已连接的平台');
      await this.models.assertModelAvailable(userId, modelConfigId, modelName);
    }
    const updated = await this.prisma.session.update({
      where: { id },
      data: {
        ...(dto.modelConfigId !== undefined ? { modelConfigId: dto.modelConfigId } : {}),
        ...(dto.modelName !== undefined ? { modelName: dto.modelName } : {}),
        ...(dto.modelConfigId !== undefined && dto.modelName === undefined ? { modelName: null } : {}),
      },
    });
    return this.publicSession(updated, userId);
  }

  async findByProject(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, 'read');
    const sessions = await this.prisma.session.findMany({
      where: { projectId, userId },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map((session) => this.publicSession(session, userId));
  }

  async findOne(userId: string, id: string) {
    await this.access.requireSession(userId, id, 'read');
    const session = await this.prisma.session.findFirst({
      where: { id, userId },
      include: {
        tasks: { orderBy: { createdAt: 'desc' }, take: 500 },
        sandbox: true,
      },
    });
    return session ? this.publicSession(session, userId) : null;
  }

  private publicSession<T extends { userId: string; workspacePath: string | null }>(
    session: T,
    userId: string,
  ) {
    const { workspacePath: _workspacePath, ...safe } = session;
    return { ...safe, userWorkspace: session.userId === userId };
  }
}
