import { Injectable } from '@nestjs/common';
import { PageQueryDto } from '../common/dto/page-query.dto';
import { ProjectService } from './project.service';

@Injectable()
export class ProjectMcpFacade {
  constructor(private readonly projects: ProjectService) {}

  async list(userId: string, input: { page: number; pageSize: number }) {
    const result = await this.projects.findAll(
      userId,
      Object.assign(new PageQueryDto(), input),
    );
    return {
      ...result,
      items: result.items.map((project) => ({
        id: project.id,
        name: project.name,
        language: project.language,
        status: project.status,
        team: project.team,
        repository: project.remote,
        accessRole: project.accessRole,
        memberCount: project._count.members,
        createdAt: project.createdAt,
      })),
    };
  }

  async get(userId: string, projectId: string) {
    const project = await this.projects.findOne(userId, projectId);
    return {
      id: project.id,
      name: project.name,
      language: project.language,
      status: project.status,
      team: project.team ? { id: project.team.id, name: project.team.name } : null,
      repository: project.remote,
      accessRole: project.accessRole,
      createdAt: project.createdAt,
      currentUserSession: project.sessions
        .filter((session) => session.userId === userId)
        .map((session) => ({
          id: session.id,
          workspaceBranch: session.workspaceBranch,
          createdAt: session.createdAt,
        }))[0] ?? null,
      members: project.members.map((member) => ({
        id: member.user.id,
        username: member.user.username,
        role: member.role,
      })),
    };
  }
}
