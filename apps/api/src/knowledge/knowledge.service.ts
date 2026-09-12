import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";
import {
  CreateDocumentDto,
  CreateFolderDto,
  SaveDocumentDto,
  UpdateDocumentDto,
  UpdateFolderDto,
} from "./dto/knowledge.dto";

const userSelect = { id: true, username: true, displayName: true } as const;
@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}
  private async member(userId: string, teamId: string) {
    const team = await this.prisma.team.findFirst({
      where: {
        id: teamId,
        members: { some: { id: userId, status: "active" } },
      },
      select: { id: true, name: true },
    });
    if (!team)
      throw new ForbiddenException({
        code: "KNOWLEDGE_TEAM_ACCESS_DENIED",
        message: "无权访问该团队知识库",
      });
    return team;
  }
  private async document(userId: string, id: string) {
    const doc = await this.prisma.knowledgeDocument.findUnique({
      where: { id },
      include: {
        team: { select: { id: true, name: true } },
        folder: true,
        requirement: { select: { id: true, requirementNo: true, title: true } },
        createdBy: { select: userSelect },
        updatedBy: { select: userSelect },
      },
    });
    if (!doc)
      throw new NotFoundException({
        code: "KNOWLEDGE_DOCUMENT_NOT_FOUND",
        message: "知识文档不存在",
      });
    await this.member(userId, doc.teamId);
    return doc;
  }
  async teams(userId: string) {
    return this.prisma.team.findMany({
      where: { members: { some: { id: userId, status: "active" } } },
      select: {
        id: true,
        name: true,
        _count: {
          select: { knowledgeFolders: true, knowledgeDocuments: true },
        },
      },
      orderBy: { name: "asc" },
    });
  }
  async tree(userId: string, teamId: string) {
    const team = await this.member(userId, teamId);
    const [folders, documents] = await Promise.all([
      this.prisma.knowledgeFolder.findMany({
        where: { teamId },
        orderBy: { name: "asc" },
      }),
      this.prisma.knowledgeDocument.findMany({
        where: { teamId },
        select: {
          id: true,
          folderId: true,
          requirementId: true,
          title: true,
          version: true,
          updatedAt: true,
          updatedBy: { select: userSelect },
        },
        orderBy: { updatedAt: "desc" },
      }),
    ]);
    return { team, folders, documents };
  }
  async createFolder(userId: string, input: CreateFolderDto) {
    await this.member(userId, input.teamId);
    const name = input.name.trim();
    if (!name)
      throw new BadRequestException({
        code: "KNOWLEDGE_FOLDER_NAME_REQUIRED",
        message: "文件夹名称不能为空",
      });
    if (input.parentId) {
      const parent = await this.prisma.knowledgeFolder.findFirst({
        where: { id: input.parentId, teamId: input.teamId },
      });
      if (!parent)
        throw new BadRequestException({
          code: "KNOWLEDGE_PARENT_INVALID",
          message: "父文件夹不属于当前知识库",
        });
    }
    return this.prisma.knowledgeFolder.create({
      data: {
        teamId: input.teamId,
        parentId: input.parentId || null,
        name,
        createdById: userId,
      },
    });
  }
  async updateFolder(userId: string, id: string, input: UpdateFolderDto) {
    const folder = await this.prisma.knowledgeFolder.findUnique({
      where: { id },
    });
    if (!folder)
      throw new NotFoundException({
        code: "KNOWLEDGE_FOLDER_NOT_FOUND",
        message: "文件夹不存在",
      });
    await this.member(userId, folder.teamId);
    if (input.parentId === id)
      throw new BadRequestException({
        code: "KNOWLEDGE_FOLDER_CYCLE",
        message: "文件夹不能移动到自身",
      });
    if (
      input.parentId &&
      !(await this.prisma.knowledgeFolder.findFirst({
        where: { id: input.parentId, teamId: folder.teamId },
      }))
    )
      throw new BadRequestException({
        code: "KNOWLEDGE_PARENT_INVALID",
        message: "目标文件夹不属于当前知识库",
      });
    return this.prisma.knowledgeFolder.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.parentId !== undefined
          ? { parentId: input.parentId || null }
          : {}),
      },
    });
  }
  async deleteFolder(userId: string, id: string) {
    const folder = await this.prisma.knowledgeFolder.findUnique({
      where: { id },
      include: { _count: { select: { children: true, documents: true } } },
    });
    if (!folder)
      throw new NotFoundException({
        code: "KNOWLEDGE_FOLDER_NOT_FOUND",
        message: "文件夹不存在",
      });
    await this.member(userId, folder.teamId);
    if (folder._count.children || folder._count.documents)
      throw new ConflictException({
        code: "KNOWLEDGE_FOLDER_NOT_EMPTY",
        message: "文件夹非空，请先移动或删除其中内容",
      });
    await this.prisma.knowledgeFolder.delete({ where: { id } });
    return { deleted: true };
  }
  async createDocument(userId: string, input: CreateDocumentDto) {
    await this.member(userId, input.teamId);
    if (
      input.folderId &&
      !(await this.prisma.knowledgeFolder.findFirst({
        where: { id: input.folderId, teamId: input.teamId },
      }))
    )
      throw new BadRequestException({
        code: "KNOWLEDGE_FOLDER_INVALID",
        message: "文件夹不属于当前知识库",
      });
    if (
      input.requirementId &&
      !(await this.prisma.requirement.findFirst({
        where: { id: input.requirementId, teamId: input.teamId },
      }))
    )
      throw new BadRequestException({
        code: "KNOWLEDGE_REQUIREMENT_INVALID",
        message: "需求不属于当前团队",
      });
    const title = input.title.trim();
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.knowledgeDocument.create({
        data: {
          teamId: input.teamId,
          folderId: input.folderId || null,
          requirementId: input.requirementId || null,
          title,
          createdById: userId,
          updatedById: userId,
        },
      });
      await tx.knowledgeDocumentRevision.create({
        data: {
          documentId: doc.id,
          version: 1,
          contentMarkdown: "",
          changeSummary: "创建文档",
          createdById: userId,
        },
      });
      return doc;
    });
  }
  async resolveRequirementDocument(userId: string, requirementId: string) {
    const existing = await this.prisma.knowledgeDocument.findUnique({
      where: { requirementId },
    });
    if (existing) {
      await this.member(userId, existing.teamId);
      return existing;
    }
    const requirement = await this.prisma.requirement.findUnique({
      where: { id: requirementId },
      include: { revisions: { orderBy: { version: "asc" } } },
    });
    if (!requirement)
      throw new NotFoundException({
        code: "REQUIREMENT_NOT_FOUND",
        message: "需求不存在",
      });
    await this.member(userId, requirement.teamId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const doc = await tx.knowledgeDocument.create({
          data: {
            teamId: requirement.teamId,
            requirementId,
            title: `${requirement.requirementNo} ${requirement.title}`,
            contentMarkdown: requirement.contentMarkdown,
            version: requirement.documentVersion,
            createdById: requirement.createdById,
            updatedById:
              requirement.revisions.at(-1)?.createdById ||
              requirement.createdById,
            createdAt: requirement.createdAt,
            updatedAt: requirement.updatedAt,
          },
        });
        if (requirement.revisions.length)
          await tx.knowledgeDocumentRevision.createMany({
            data: requirement.revisions.map((item) => ({
              documentId: doc.id,
              version: item.version,
              contentMarkdown: item.contentMarkdown,
              changeSummary: item.changeSummary,
              createdById: item.createdById,
              createdAt: item.createdAt,
            })),
          });
        else
          await tx.knowledgeDocumentRevision.create({
            data: {
              documentId: doc.id,
              version: requirement.documentVersion,
              contentMarkdown: requirement.contentMarkdown,
              changeSummary: "从需求文档迁移",
              createdById: requirement.createdById,
            },
          });
        return doc;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        return this.prisma.knowledgeDocument.findUniqueOrThrow({
          where: { requirementId },
        });
      throw error;
    }
  }
  async detail(userId: string, id: string) {
    return this.document(userId, id);
  }
  async update(userId: string, id: string, input: UpdateDocumentDto) {
    const doc = await this.document(userId, id);
    if (
      input.folderId &&
      !(await this.prisma.knowledgeFolder.findFirst({
        where: { id: input.folderId, teamId: doc.teamId },
      }))
    )
      throw new BadRequestException({
        code: "KNOWLEDGE_FOLDER_INVALID",
        message: "文件夹不属于当前知识库",
      });
    return this.prisma.knowledgeDocument.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.folderId !== undefined
          ? { folderId: input.folderId || null }
          : {}),
        updatedById: userId,
      },
    });
  }
  async deleteDocument(userId: string, id: string) {
    const doc = await this.document(userId, id);
    if (doc.requirementId)
      throw new ConflictException({
        code: "KNOWLEDGE_REQUIREMENT_DOCUMENT_DELETE_DENIED",
        message: "需求关联文档不能从知识库直接删除",
      });
    await this.prisma.knowledgeDocument.delete({ where: { id } });
    return { deleted: true };
  }
  async save(userId: string, id: string, input: SaveDocumentDto) {
    await this.document(userId, id);
    const layoutJson = input.layoutJson as Prisma.InputJsonValue | undefined;
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.knowledgeDocument.updateMany({
        where: { id, version: input.baseVersion },
        data: {
          contentMarkdown: input.contentMarkdown,
          layoutJson,
          version: { increment: 1 },
          updatedById: userId,
        },
      });
      if (!result.count)
        throw new ConflictException({
          code: "KNOWLEDGE_DOCUMENT_VERSION_CONFLICT",
          message: "文档已被其他成员更新，请刷新后合并",
        });
      const version = input.baseVersion + 1;
      await tx.knowledgeDocumentRevision.create({
        data: {
          documentId: id,
          version,
          contentMarkdown: input.contentMarkdown,
          layoutJson,
          changeSummary: input.changeSummary?.trim() || null,
          createdById: userId,
        },
      });
      return { id, version };
    });
  }
  async revisions(userId: string, id: string) {
    await this.document(userId, id);
    return this.prisma.knowledgeDocumentRevision.findMany({
      where: { documentId: id },
      select: {
        id: true,
        version: true,
        changeSummary: true,
        createdAt: true,
        createdBy: { select: userSelect },
      },
      orderBy: { version: "desc" },
      take: 50,
    });
  }
}
