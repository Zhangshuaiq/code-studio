import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformHealthService } from './platform-health.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';

@Controller('platform-health')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.BUSINESS_LOG_READ)
export class PlatformHealthController {
  constructor(private readonly health: PlatformHealthService) {}

  @Get()
  overview() {
    return this.health.overview();
  }

  @Get('projects/:id/usage')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  projectUsage(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.health.projectUsage(user.id, projectId);
  }
}
