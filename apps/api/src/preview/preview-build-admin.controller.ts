import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Audit } from '../audit/audit.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PERMISSIONS } from '../auth/permissions';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { K8sPreviewService } from './k8s-preview.service';
import { AdminPreviewBuildQueryDto } from './dto/preview-build-query.dto';

@Controller('admin/preview-builds')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
export class PreviewBuildAdminController {
  constructor(private readonly builds: K8sPreviewService) {}

  @Get()
  list(@Query() query: AdminPreviewBuildQueryDto) {
    return this.builds.adminBuilds(query);
  }

  @Post(':id/cancel')
  @Audit('preview-build.cancel', 'preview-build')
  cancel(@Param('id') id: string) {
    return this.builds.adminCancel(id);
  }
}
