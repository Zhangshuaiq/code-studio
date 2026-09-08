import { Injectable } from '@nestjs/common';
import { RequirementQueryDto } from './dto/requirement.dto';
import { RequirementService } from './requirement.service';

@Injectable()
export class RequirementMcpFacade {
  constructor(private readonly requirements: RequirementService) {}

  async list(userId: string, input: {
    page: number;
    pageSize: number;
    teamId?: string;
    status?: string;
  }) {
    const result = await this.requirements.list(
      userId,
      Object.assign(new RequirementQueryDto(), input),
    );
    return {
      ...result,
      items: result.items.map((requirement) => ({
        id: requirement.id,
        requirementNo: requirement.requirementNo,
        title: requirement.title,
        summary: requirement.summary,
        status: requirement.status,
        currentStage: requirement.currentStage,
        progress: requirement.progress,
        plannedStartAt: requirement.plannedStartAt,
        plannedEndAt: requirement.plannedEndAt,
        owner: publicUser(requirement.owner),
        team: requirement.team,
        stages: requirement.stages.map((stage) => ({
          type: stage.type,
          status: stage.status,
          progress: stage.progress,
          owner: publicUser(stage.owner),
        })),
        projectCount: requirement._count.projects,
        previewCount: requirement._count.previews,
        updatedAt: requirement.updatedAt,
      })),
    };
  }

  async get(userId: string, requirementId: string) {
    const requirement = await this.requirements.detail(userId, requirementId);
    return {
      id: requirement.id,
      requirementNo: requirement.requirementNo,
      title: requirement.title,
      summary: requirement.summary,
      contentMarkdown: requirement.contentMarkdown,
      documentVersion: requirement.documentVersion,
      status: requirement.status,
      currentStage: requirement.currentStage,
      progress: requirement.progress,
      plannedStartAt: requirement.plannedStartAt,
      plannedEndAt: requirement.plannedEndAt,
      owner: publicUser(requirement.owner),
      team: { id: requirement.team.id, name: requirement.team.name },
      stages: requirement.stages.map((stage) => ({
        id: stage.id,
        type: stage.type,
        sortOrder: stage.sortOrder,
        status: stage.status,
        progress: stage.progress,
        descriptionMarkdown: stage.descriptionMarkdown,
        blockedReason: stage.blockedReason,
        plannedStartAt: stage.plannedStartAt,
        plannedEndAt: stage.plannedEndAt,
        startedAt: stage.startedAt,
        completedAt: stage.completedAt,
        owner: publicUser(stage.owner),
      })),
      projects: requirement.projects.map((link) => ({
        id: link.id,
        project: link.project,
        serviceKey: link.serviceKey,
        developer: publicUser(link.developer),
        branchName: link.branchName,
        changeRequired: link.changeRequired,
        status: link.status,
      })),
      previews: requirement.previews.map((preview) => ({
        id: preview.id,
        serviceKey: preview.serviceKey,
        status: preview.status,
        url: preview.url,
        targetName: preview.targetName,
        lastActiveAt: preview.lastActiveAt,
      })),
      createdAt: requirement.createdAt,
      updatedAt: requirement.updatedAt,
    };
  }
}

function publicUser(user: { id: string; username: string } | null) {
  return user ? { id: user.id, username: user.username } : null;
}
