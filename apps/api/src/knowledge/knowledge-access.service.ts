import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type KnowledgePermission = 'view' | 'edit' | 'delete';
export type KnowledgeRights = { view: boolean; edit: boolean; delete: boolean };
export type KnowledgeGrantInput = {
  granteeKind: string; granteeId: string;
  canView: boolean; canEdit: boolean; canDelete: boolean;
};

const none = (): KnowledgeRights => ({ view: false, edit: false, delete: false });
const all = (): KnowledgeRights => ({ view: true, edit: true, delete: true });
const denied = (resource: 'base' | 'document', permission: KnowledgePermission) => new ForbiddenException({
  code: resource === 'base' ? 'KNOWLEDGE_BASE_ACCESS_DENIED' : 'KNOWLEDGE_DOCUMENT_ACCESS_DENIED',
  message: '无权限', permission,
});

@Injectable()
export class KnowledgeAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async context(userId: string) {
    const [teams, admin] = await Promise.all([
      this.prisma.team.findMany({ where: { members: { some: { id: userId, status: 'active' } } }, select: { id: true } }),
      this.prisma.user.count({ where: { id: userId, roles: { some: { name: 'admin' } } } }),
    ]);
    return { teamIds: new Set(teams.map((team) => team.id)), admin: admin > 0 };
  }

  private fromGrants(grants: KnowledgeGrantInput[], userId: string, teamIds: Set<string>): KnowledgeRights {
    const result = none();
    for (const grant of grants) {
      if (grant.granteeKind === 'user' ? grant.granteeId !== userId : !teamIds.has(grant.granteeId)) continue;
      result.view ||= grant.canView || grant.canEdit || grant.canDelete;
      result.edit ||= grant.canEdit || grant.canDelete;
      result.delete ||= grant.canDelete;
    }
    return result;
  }

  baseRights(base: { id: string; createdById?: string | null; knowledgeAccessMode: string }, grants: KnowledgeGrantInput[], userId: string, context: { teamIds: Set<string>; admin: boolean }): KnowledgeRights {
    if (context.admin || base.createdById === userId) return all();
    const explicit = this.fromGrants(grants, userId, context.teamIds);
    if (base.knowledgeAccessMode !== 'custom' && context.teamIds.has(base.id)) return all();
    return explicit;
  }

  documentRights(doc: { createdById: string; accessMode: string }, grants: KnowledgeGrantInput[], inherited: KnowledgeRights, userId: string, context: { teamIds: Set<string>; admin: boolean }): KnowledgeRights {
    if (context.admin || doc.createdById === userId) return all();
    const direct = this.fromGrants(grants, userId, context.teamIds);
    if (doc.accessMode === 'custom') return direct;
    return { view: inherited.view || direct.view, edit: inherited.edit || direct.edit, delete: inherited.delete || direct.delete };
  }

  async requireBase(userId: string, teamId: string, permission: KnowledgePermission = 'view') {
    const base = await this.prisma.team.findUnique({ where: { id: teamId }, include: { knowledgeBaseGrants: true, createdBy: { select: { id: true, username: true, displayName: true } } } });
    if (!base) throw new NotFoundException('知识库不存在');
    const rights = this.baseRights(base, base.knowledgeBaseGrants, userId, await this.context(userId));
    if (!rights[permission]) throw denied('base', permission);
    return { base, rights };
  }

  async rightsForDocument(userId: string, doc: { id: string; teamId: string; createdById: string; accessMode: string; accessGrants?: KnowledgeGrantInput[] }, context?: Awaited<ReturnType<KnowledgeAccessService['context']>>) {
    const current = context ?? await this.context(userId);
    const base = await this.prisma.team.findUnique({ where: { id: doc.teamId }, include: { knowledgeBaseGrants: true } });
    if (!base) return none();
    const inherited = this.baseRights(base, base.knowledgeBaseGrants, userId, current);
    const grants = doc.accessGrants ?? await this.prisma.knowledgeDocumentGrant.findMany({ where: { documentId: doc.id } });
    return this.documentRights(doc, grants, inherited, userId, current);
  }

  async requireDocument(userId: string, documentId: string, permission: KnowledgePermission = 'view') {
    const doc = await this.prisma.knowledgeDocument.findUnique({ where: { id: documentId }, include: { accessGrants: true } });
    if (!doc) throw new NotFoundException('知识文档不存在');
    const rights = await this.rightsForDocument(userId, doc);
    if (!rights[permission]) throw denied('document', permission);
    return { doc, rights };
  }

  async baseAcl(userId: string, teamId: string) {
    const { base } = await this.requireBase(userId, teamId, 'view');
    if (!(await this.context(userId)).admin && base.createdById !== userId) throw denied('base', 'delete');
    return { mode: base.knowledgeAccessMode, grants: base.knowledgeBaseGrants, creator: base.createdBy };
  }

  async documentAcl(userId: string, documentId: string) {
    const { doc } = await this.requireDocument(userId, documentId, 'view');
    if (!(await this.context(userId)).admin && doc.createdById !== userId) throw denied('document', 'delete');
    return { mode: doc.accessMode, grants: doc.accessGrants };
  }

  async grantOptions(userId: string) {
    const [teams, users] = await Promise.all([
      this.prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.user.findMany({ where: { status: 'active' }, select: { id: true, username: true, displayName: true }, orderBy: { username: 'asc' }, take: 1000 }),
    ]);
    if (!(await this.prisma.user.count({ where: { id: userId, status: 'active' } }))) throw new ForbiddenException('账户不可用');
    return { teams, users };
  }

  private async validateGrants(grants: KnowledgeGrantInput[]) {
    if (grants.length > 200) throw new BadRequestException('授权对象过多');
    const keys = new Set<string>();
    for (const grant of grants) {
      if (!['team', 'user'].includes(grant.granteeKind) || !/^[a-zA-Z0-9_-]{1,128}$/.test(grant.granteeId)) throw new BadRequestException('授权对象无效');
      if (keys.has(`${grant.granteeKind}:${grant.granteeId}`)) throw new BadRequestException('授权对象重复');
      keys.add(`${grant.granteeKind}:${grant.granteeId}`);
      const exists = grant.granteeKind === 'team'
        ? await this.prisma.team.count({ where: { id: grant.granteeId } })
        : await this.prisma.user.count({ where: { id: grant.granteeId, status: 'active' } });
      if (!exists) throw new BadRequestException('授权对象不存在');
    }
  }

  async setBaseAcl(userId: string, teamId: string, mode: 'default' | 'custom', grants: KnowledgeGrantInput[]) {
    await this.baseAcl(userId, teamId);
    await this.validateGrants(grants);
    await this.prisma.$transaction(async (tx) => {
      await tx.knowledgeBaseGrant.deleteMany({ where: { teamId } });
      if (grants.length) await tx.knowledgeBaseGrant.createMany({ data: grants.map((item) => ({ teamId, ...item })) });
      await tx.team.update({ where: { id: teamId }, data: { knowledgeAccessMode: mode } });
    });
    return { ok: true };
  }

  async setDocumentAcl(userId: string, documentId: string, mode: 'inherit' | 'custom', grants: KnowledgeGrantInput[]) {
    await this.documentAcl(userId, documentId);
    await this.validateGrants(grants);
    await this.prisma.$transaction(async (tx) => {
      await tx.knowledgeDocumentGrant.deleteMany({ where: { documentId } });
      if (grants.length) await tx.knowledgeDocumentGrant.createMany({ data: grants.map((item) => ({ documentId, ...item })) });
      await tx.knowledgeDocument.update({ where: { id: documentId }, data: { accessMode: mode } });
    });
    return { ok: true };
  }

  async documentAccess(userId: string, documentId: string) {
    const doc = await this.prisma.knowledgeDocument.findUnique({ where: { id: documentId }, select: { id: true, teamId: true, createdById: true, accessMode: true, accessGrants: true, createdBy: { select: { id: true, username: true, displayName: true } } } });
    if (!doc) throw new NotFoundException('知识文档不存在');
    const [permissions, request] = await Promise.all([
      this.rightsForDocument(userId, doc),
      this.prisma.knowledgePermissionRequest.findUnique({ where: { documentId_requesterId: { documentId, requesterId: userId } }, select: { status: true, permission: true } }),
    ]);
    return { permissions, creator: doc.createdBy, request };
  }

  async requestDocumentAccess(userId: string, documentId: string, permission: KnowledgePermission, message?: string) {
    const info = await this.documentAccess(userId, documentId);
    if (info.permissions[permission]) throw new BadRequestException('已拥有该权限');
    if (info.creator.id === userId) throw new BadRequestException('创建人无需申请权限');
    return this.prisma.knowledgePermissionRequest.upsert({
      where: { documentId_requesterId: { documentId, requesterId: userId } },
      create: { documentId, requesterId: userId, permission, message: message?.trim() || null },
      update: { permission, message: message?.trim() || null, status: 'pending', handledAt: null, createdAt: new Date() },
      select: { id: true, status: true, permission: true },
    });
  }

  async requestInbox(userId: string) {
    const admin = (await this.context(userId)).admin;
    return this.prisma.knowledgePermissionRequest.findMany({
      where: { status: 'pending', ...(admin ? {} : { document: { createdById: userId } }) },
      include: { document: { select: { id: true, title: true, createdById: true } }, requester: { select: { id: true, username: true, displayName: true } } },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  }

  async reviewRequest(userId: string, requestId: string, approve: boolean) {
    const request = await this.prisma.knowledgePermissionRequest.findUnique({ where: { id: requestId }, include: { document: { select: { createdById: true } } } });
    if (!request) throw new NotFoundException('权限申请不存在');
    if (request.document.createdById !== userId && !(await this.context(userId)).admin) throw denied('document', 'delete');
    if (request.status !== 'pending') throw new BadRequestException('申请已处理');
    await this.prisma.$transaction(async (tx) => {
      if (approve) {
        const current = await tx.knowledgeDocumentGrant.findUnique({ where: { documentId_granteeKind_granteeId: { documentId: request.documentId, granteeKind: 'user', granteeId: request.requesterId } } });
        await tx.knowledgeDocumentGrant.upsert({
          where: { documentId_granteeKind_granteeId: { documentId: request.documentId, granteeKind: 'user', granteeId: request.requesterId } },
          create: { documentId: request.documentId, granteeKind: 'user', granteeId: request.requesterId, canView: true, canEdit: request.permission !== 'view', canDelete: request.permission === 'delete' },
          update: { canView: true, canEdit: Boolean(current?.canEdit || request.permission !== 'view'), canDelete: Boolean(current?.canDelete || request.permission === 'delete') },
        });
      }
      await tx.knowledgePermissionRequest.update({ where: { id: requestId }, data: { status: approve ? 'approved' : 'rejected', handledAt: new Date() } });
    });
    return { ok: true };
  }
}
