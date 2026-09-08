import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";
import { ProjectAccessService } from "../project-access/project-access.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { GitService } from "../git/git.service";
import { DeployTargetService } from "./deploy-target.service";
import { DeployService } from "./deploy.service";
import { validatePreviewBindingConfig } from "../preview/k8s-preview.service";
import { DatasourceService } from "../datasource/datasource.service";
import { DeploymentRecordQueryDto, RunDeploymentDto, SaveRuntimeBindingDto } from "./dto/deployment-center.dto";
import { RegistryService } from "./registry.service";
import { pageArgs, pageResult } from "../common/dto/page-query.dto";
import { DistributedWorkspaceLockService } from "../workspace/distributed-workspace-lock.service";

@Injectable()
export class DeploymentCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly workspaces: WorkspaceService,
    private readonly git: GitService,
    private readonly targets: DeployTargetService,
    private readonly deploy: DeployService,
    private readonly datasources: DatasourceService,
    private readonly registries: RegistryService,
    private readonly workspaceLock: DistributedWorkspaceLockService,
  ) {}

  async projects(userId: string) {
    const rows = await this.prisma.project.findMany({
      where: this.access.visibleWhere(userId),
      include: {
        team: { select: { id: true, name: true } },
        remote: { select: { branch: true, remoteUrl: true } },
        members: { where: { userId }, select: { role: true } },
        runtimeBindings: {
          where: { enabled: true },
          include: {
            target: {
              select: { id: true, name: true, kind: true, enabled: true },
            },
          },
          orderBy: [{ purpose: "asc" }, { environment: "asc" }],
        },
        deployment: true,
      },
      orderBy: [{ team: { name: "asc" } }, { name: "asc" }],
    });
    return rows.map((project) => ({
      id: project.id,
      name: project.name,
      language: project.language,
      status: project.status,
      team: project.team,
      remote: project.remote,
      accessRole:
        project.userId === userId
          ? "owner"
          : project.members[0]?.role || "viewer",
      environments: project.runtimeBindings,
      deployment: project.deployment,
    }));
  }

  async branches(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "read");
    const session = await this.releaseSession(userId, projectId);
    const workspace = await this.workspaces.ensureForSession(
      userId,
      session.id,
    );
    return this.git.branches(workspace.path);
  }

  async bindings(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "read");
    return this.prisma.projectRuntimeBinding.findMany({
      where: { projectId },
      include: {
        target: {
          select: {
            id: true,
            name: true,
            kind: true,
            summary: true,
            purposes: true,
            labels: true,
            enabled: true,
          },
        },
      },
      orderBy: [{ purpose: "asc" }, { environment: "asc" }],
    });
  }

  async status(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "read");
    const session = await this.releaseSession(userId, projectId);
    return this.deploy.get(userId, session.id);
  }

  async saveBinding(
    userId: string,
    input: SaveRuntimeBindingDto,
  ) {
    const project = await this.access.requireProject(
      userId,
      input.projectId,
      "manage",
    );
    const purpose = input.purpose?.trim();
    if (!["preview", "deploy"].includes(purpose)) {
      throw new BadRequestException("绑定用途必须是 preview 或 deploy");
    }
    const environment = input.environment?.trim().toLowerCase();
    if (!environment || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(environment)) {
      throw new BadRequestException(
        "环境标识只能使用小写字母、数字、下划线或连字符",
      );
    }
    if (purpose === "preview" && environment !== "preview") {
      throw new BadRequestException("个人预览绑定的环境标识必须是 preview");
    }
    if (purpose === "deploy" && environment === "preview") {
      throw new BadRequestException("统一部署环境不能使用 preview 标识");
    }
    const target = await this.targets.resolveConfig(userId, input.targetId);
    if (!target.enabled) throw new BadRequestException("所选运行目标已停用");
    if (!target.purposes.includes(purpose)) {
      throw new BadRequestException(
        `所选目标未启用${purpose === "preview" ? "预览" : "部署"}用途`,
      );
    }
    if (purpose === "preview" && target.kind === "k8s") {
      const previewConfig = validatePreviewBindingConfig(input.config || {});
      if (!previewConfig.testNamespace || !previewConfig.testServiceName || !previewConfig.testServicePort) {
        throw new BadRequestException({ code: "PREVIEW_TEST_SERVICE_REQUIRED", message: "Kubernetes 预览绑定必须配置测试 Namespace、Service 和端口" });
      }
      if (previewConfig.registryId) {
        const registry = await this.registries.resolveConfig(target.ownerId, previewConfig.registryId);
        if (registry.insecure) {
          throw new BadRequestException({ code: "DEPLOY_TARGET_REGISTRY_INSECURE", message: "Kubernetes 预览只能使用启用 TLS 的镜像仓库" });
        }
      }
    }
    if (target.scope === "team" && target.teamId !== project.teamId) {
      throw new BadRequestException("项目与运行资源不属于同一个项目组");
    }
    const datasourceId = jsonString(input.config, 'datasourceId');
    if (purpose === 'deploy' && datasourceId) {
      await this.datasources.resolveForDeployment(userId, datasourceId, project.teamId);
    }
    const branchPattern = input.branchPattern?.trim() || "*";
    if (branchPattern.length > 120 || /[\0\r\n]/.test(branchPattern)) {
      throw new BadRequestException("分支规则格式不正确");
    }
    return this.prisma.projectRuntimeBinding.upsert({
      where: {
        projectId_purpose_environment: {
          projectId: input.projectId,
          purpose,
          environment,
        },
      },
      create: {
        projectId: input.projectId,
        targetId: input.targetId,
        purpose,
        environment,
        branchPattern,
        config: (input.config || {}) as Prisma.InputJsonObject,
        enabled: input.enabled ?? true,
      },
      update: {
        targetId: input.targetId,
        branchPattern,
        config: (input.config || {}) as Prisma.InputJsonObject,
        enabled: input.enabled ?? true,
      },
      include: { target: { select: { id: true, name: true, kind: true } } },
    });
  }

  async removeBinding(userId: string, id: string) {
    const binding = await this.prisma.projectRuntimeBinding.findUnique({
      where: { id },
      select: { id: true, projectId: true },
    });
    if (!binding) throw new NotFoundException("项目环境绑定不存在");
    await this.access.requireProject(userId, binding.projectId, "manage");
    await this.prisma.projectRuntimeBinding.delete({ where: { id } });
    return { ok: true };
  }

  async run(
    userId: string,
    username: string,
    input: RunDeploymentDto,
  ) {
    await this.access.requireProject(userId, input.projectId, "read");
    return this.workspaceLock.runExclusive(`deployment:${input.projectId}:${input.bindingId}`, () =>
      this.runLocked(userId, username, input),
    );
  }

  private async runLocked(
    userId: string,
    username: string,
    input: RunDeploymentDto,
  ) {
    const binding = await this.prisma.projectRuntimeBinding.findFirst({
      where: {
        id: input.bindingId,
        projectId: input.projectId,
        purpose: "deploy",
        enabled: true,
      },
      include: { target: true },
    });
    if (!binding) throw new NotFoundException("项目部署环境不存在或已停用");
    if (!binding.target.enabled)
      throw new BadRequestException("部署目标已停用");
    const active = await this.prisma.deployment.findUnique({
      where: { projectId: input.projectId },
      select: { status: true, updatedAt: true },
    });
    if (
      active?.status === "building" &&
      Date.now() - active.updatedAt.getTime() < 30 * 60 * 1000
    ) {
      throw new BadRequestException("该项目已有部署任务正在执行，请等待完成");
    }
    const branch = input.branch?.trim();
    if (!branch || !matchesBranch(branch, binding.branchPattern)) {
      throw new BadRequestException(
        `分支 ${branch || "（空）"} 不符合环境规则 ${binding.branchPattern}`,
      );
    }

    const session = await this.releaseSession(userId, input.projectId);
    const workspace = await this.workspaces.ensureForSession(
      userId,
      session.id,
    );
    const available = await this.git.branches(workspace.path);
    if (!available.list.includes(branch)) {
      throw new BadRequestException(
        `本地工作区不存在分支 ${branch}，请先同步远端`,
      );
    }
    const deploymentPath = await this.workspaces.ensureForDeployment(
      input.projectId,
      binding.environment,
      branch,
    );
    return this.deploy.deploy(userId, session.id, binding.targetId, {
      environment: binding.environment,
      branch,
      deployedByName: username,
      sourcePath: deploymentPath,
      datasourceId: jsonString(binding.config, 'datasourceId') || undefined,
    });
  }

  async records(userId: string, query: DeploymentRecordQueryDto) {
    if (query.projectId) await this.access.requireProject(userId, query.projectId, "read");
    const visible = await this.prisma.project.findMany({
      where: {
        ...this.access.visibleWhere(userId),
        ...(query.projectId ? { id: query.projectId } : {}),
      },
      select: { id: true },
    });
    const where = { projectId: { in: visible.map((item) => item.id) } };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.deploymentRecord.findMany({
      where,
      ...pageArgs(query),
      include: {
        project: {
          select: {
            id: true,
            name: true,
            team: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
      this.prisma.deploymentRecord.count({ where }),
    ]);
    return pageResult(items, total, query);
  }

  async stop(userId: string, projectId: string) {
    await this.access.requireProject(userId, projectId, "read");
    const current = await this.prisma.deployment.findUnique({
      where: { projectId },
      select: { status: true },
    });
    if (current?.status === "building") {
      throw new BadRequestException(
        "部署任务仍在构建，当前版本尚不支持取消构建",
      );
    }
    const session = await this.releaseSession(userId, projectId);
    return this.deploy.stop(userId, session.id);
  }

  private async releaseSession(userId: string, projectId: string) {
    return this.prisma.session.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId },
      update: {},
    });
  }
}

function matchesBranch(branch: string, pattern: string) {
  if (!pattern || pattern === "*") return true;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(branch);
}

function jsonString(value: unknown, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field.trim() : '';
}
