import { Body, Controller, Get, Param, Put, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { MonitoringConfigInput, MonitoringConfigService, MonitoringKind } from './monitoring-config.service';
import { Audit } from '../audit/audit.decorator';

@Controller('monitoring-config')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
export class MonitoringConfigController {
  constructor(private readonly service: MonitoringConfigService) {}
  @Get() list() { return this.service.list(); }
  @Audit('monitoring.connection.update', 'monitoring-connection', false)
  @Put(':kind') save(@Param('kind') kind: MonitoringKind, @Body() body: MonitoringConfigInput, @CurrentUser() user: AuthUser) { return this.service.save(kind, body, user.id); }
  @Audit('monitoring.connection.test', 'monitoring-connection', false)
  @Post(':kind/test') test(@Param('kind') kind: MonitoringKind, @Body() body: Partial<MonitoringConfigInput>) { return this.service.test(kind, body.url ? body as MonitoringConfigInput : undefined); }
}
