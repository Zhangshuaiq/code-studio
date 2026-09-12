import { Controller, Get, Post, Delete, Param, Body, UseGuards, Query } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { K8sService } from './k8s.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { Audit } from '../audit/audit.decorator';
import { NamespaceDto, ScaleDeploymentDto } from './dto/k8s-operation.dto';

@Controller('k8s')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE)
export class K8sController {
  constructor(private readonly k8s: K8sService) {}

  // 获取用户的 K8s 部署目标列表
  @Get('targets')
  async getTargets(@CurrentUser() user: { id: string }) {
    return this.k8s.getK8sTargets(user.id);
  }

  @Get(':targetId/overview')
  async clusterOverview(
    @Param('targetId') targetId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.clusterOverview(targetId, user.id);
  }

  // 获取指定目标的 Namespace 列表
  @Get(':targetId/namespaces')
  async listNamespaces(@Param('targetId') targetId: string, @CurrentUser() user: { id: string }) {
    return this.k8s.listNamespaces(targetId, user.id);
  }

  // 创建 Namespace
  @Post(':targetId/namespaces')
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE, PERMISSIONS.NAMESPACE_MANAGE)
  @Audit('k8s.namespace.create', 'namespace')
  async createNamespace(
    @Param('targetId') targetId: string,
    @Body() body: NamespaceDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.createNamespace(targetId, user.id, body.name);
  }

  @Post(':targetId/preview-namespaces/:teamId/provision')
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE, PERMISSIONS.NAMESPACE_MANAGE)
  @Audit('k8s.preview-namespace.provision', 'namespace')
  provisionPreviewNamespace(
    @Param('targetId') targetId: string,
    @Param('teamId') teamId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.provisionPreviewNamespace(targetId, user.id, teamId);
  }

  // 删除 Namespace
  @Delete(':targetId/namespaces/:name')
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE, PERMISSIONS.NAMESPACE_MANAGE)
  @Audit('k8s.namespace.delete', 'namespace')
  async deleteNamespace(
    @Param('targetId') targetId: string,
    @Param('name') name: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.deleteNamespace(targetId, user.id, name);
  }

  // 获取 Namespace 下的 Pods
  @Get(':targetId/namespaces/:namespace/pods')
  async listPods(
    @Param('targetId') targetId: string,
    @Param('namespace') namespace: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.listPods(targetId, user.id, namespace);
  }

  // 获取 Pod 详情
  @Get(':targetId/namespaces/:namespace/pods/:name')
  async getPod(
    @Param('targetId') targetId: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.getPod(targetId, user.id, namespace, name);
  }

  // 获取 Pod 日志
  @Get(':targetId/namespaces/:namespace/pods/:name/logs')
  async getPodLogs(
    @Param('targetId') targetId: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Query('tail') tail: string,
    @Query('container') container: string,
    @Query('previous') previous: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.getPodLogs(targetId, user.id, namespace, name, tail ? parseInt(tail) : 200, container, previous === 'true');
  }

  // 删除 Pod
  @Delete(':targetId/namespaces/:namespace/pods/:name')
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE, PERMISSIONS.NAMESPACE_MANAGE)
  @Audit('k8s.pod.delete', 'pod')
  async deletePod(
    @Param('targetId') targetId: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.deletePod(targetId, user.id, namespace, name);
  }

  // 获取 Deployments
  @Get(':targetId/namespaces/:namespace/deployments')
  async listDeployments(
    @Param('targetId') targetId: string,
    @Param('namespace') namespace: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.listDeployments(targetId, user.id, namespace);
  }

  // 扩缩容 Deployment
  @Post(':targetId/namespaces/:namespace/deployments/:name/scale')
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE, PERMISSIONS.NAMESPACE_MANAGE)
  @Audit('k8s.deployment.scale', 'deployment')
  async scaleDeployment(
    @Param('targetId') targetId: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body() body: ScaleDeploymentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.scaleDeployment(targetId, user.id, namespace, name, body.replicas);
  }

  // 重启 Deployment
  @Post(':targetId/namespaces/:namespace/deployments/:name/restart')
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE, PERMISSIONS.NAMESPACE_MANAGE)
  @Audit('k8s.deployment.restart', 'deployment')
  async restartDeployment(
    @Param('targetId') targetId: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.restartDeployment(targetId, user.id, namespace, name);
  }

  // 获取 Services
  @Get(':targetId/namespaces/:namespace/services')
  async listServices(
    @Param('targetId') targetId: string,
    @Param('namespace') namespace: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.k8s.listServices(targetId, user.id, namespace);
  }
}
