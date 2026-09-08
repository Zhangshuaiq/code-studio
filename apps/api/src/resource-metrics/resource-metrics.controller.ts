import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { ResourceMetricsService } from './resource-metrics.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { KubernetesNamespacesQueryDto, KubernetesPodMetricsQueryDto, ServiceMetricsQueryDto } from './dto/resource-metrics-query.dto';

@Controller('resource-metrics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.BUSINESS_LOG_READ)
export class ResourceMetricsController {
  constructor(private readonly metrics: ResourceMetricsService) {}
  @Get('health') health() { return this.metrics.health(); }
  @Get('services') services(@Query() query: ServiceMetricsQueryDto) { return this.metrics.services(query.minutes); }

  @Get('kubernetes/namespaces') namespaces(@CurrentUser() user: AuthUser, @Query() query: KubernetesNamespacesQueryDto) { return this.metrics.kubernetesNamespaces(user.id, query.targetId); }

  @Get('kubernetes/pods')
  pods(@CurrentUser() user: AuthUser, @Query() query: KubernetesPodMetricsQueryDto) {
    return this.metrics.kubernetesPods(user.id, query);
  }
}
