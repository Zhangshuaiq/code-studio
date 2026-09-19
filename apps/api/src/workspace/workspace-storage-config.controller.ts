import { BadRequestException, Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { hostname } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { Audit } from '../audit/audit.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceStorageService } from './workspace-storage.service';

const KEY = 'workspace.storage.migration-target';

class WorkspaceStorageTargetDto {
  @IsString() @MinLength(1) @MaxLength(255)
  host!: string;

  @IsString() @MinLength(2) @MaxLength(2048)
  projectsRoot!: string;

  @IsString() @MinLength(2) @MaxLength(2048)
  workspacesRoot!: string;
}

interface TargetConfig { host: string; projectsRoot: string; workspacesRoot: string }

@Controller('workspace-storage/config')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
export class WorkspaceStorageConfigController {
  constructor(private readonly prisma: PrismaService, private readonly storage: WorkspaceStorageService) {}

  @Get()
  async get() {
    const [row, projects, total] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: KEY } }),
      this.prisma.project.findMany({ select: { id: true, name: true, status: true, userId: true, storageKey: true, storagePath: true, volumePath: true }, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.prisma.project.count(),
    ]);
    const active = { host: hostname(), projectsRoot: this.storage.projectsRoot, workspacesRoot: this.storage.workspacesRoot };
    const target = row?.value as TargetConfig | undefined;
    return {
      active,
      target: target && typeof target.host === 'string' && typeof target.projectsRoot === 'string' && typeof target.workspacesRoot === 'string' ? target : null,
      targetUpdatedAt: row?.updatedAt || null,
      totalProjects: total,
      projects: projects.map((project) => {
        let path: string | null = null;
        try { path = this.storage.projectPath(project); } catch { /* 旧逻辑路径由迁移工具处理。 */ }
        return { id: project.id, name: project.name, status: project.status, path, exists: path ? existsSync(path) : false, legacyPath: project.volumePath || null };
      }),
      note: '修改目标只保存迁移计划，不会切换正在使用的路径；现有项目需先冻结写入、迁移并校验文件和 Git 元数据。',
    };
  }

  @Put()
  @Audit('workspace.storage.target.update', 'workspace-storage', false)
  async save(@Body() input: WorkspaceStorageTargetDto, @CurrentUser() user: AuthUser) {
    const host = input.host.trim();
    const projectsRoot = input.projectsRoot.trim();
    const workspacesRoot = input.workspacesRoot.trim();
    if (!host || /[\/\s]/.test(host)) throw new BadRequestException('主机名或 IP 格式不正确');
    if (!isAbsolute(projectsRoot) || !isAbsolute(workspacesRoot)) throw new BadRequestException('路径必须是绝对路径');
    const projects = resolve(projectsRoot);
    const workspaces = resolve(workspacesRoot);
    if (projects === '/' || workspaces === '/' || projects === workspaces || !relative(projects, workspaces).startsWith('..') || !relative(workspaces, projects).startsWith('..')) {
      throw new BadRequestException('项目基础路径与协作者工作区路径必须是不同且互不包含的目录，不能使用根目录');
    }
    await this.prisma.systemSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: { host, projectsRoot: projects, workspacesRoot: workspaces }, updatedById: user.id },
      update: { value: { host, projectsRoot: projects, workspacesRoot: workspaces }, updatedById: user.id },
    });
    return this.get();
  }
}
