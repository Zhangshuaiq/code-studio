import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { PreviewService } from './preview.service';
import { ProxyRequestDto } from './dto/proxy-request.dto';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { PreviewBuildQueryDto } from './dto/preview-build-query.dto';
import { StartPreviewDto } from './dto/start-preview.dto';
import { Audit } from '../audit/audit.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.PROJECT_READ)
@Controller('preview/sessions/:id')
export class PreviewController {
  constructor(private readonly preview: PreviewService) {}

  @Post('start')
  @RequirePermissions(PERMISSIONS.GENERATE)
  @Audit('preview.start', 'preview-instance')
  start(@CurrentUser() user: AuthUser, @Param('id') sessionId: string, @Body() body: StartPreviewDto) {
    return this.preview.start(user.id, sessionId, body.requirementId);
  }

  @Post('stop')
  @RequirePermissions(PERMISSIONS.GENERATE)
  @Audit('preview.stop', 'preview-instance')
  stop(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    return this.preview.stop(user.id, sessionId);
  }

  @Get('status')
  status(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    return this.preview.status(user.id, sessionId);
  }

  @Get('builds')
  builds(@CurrentUser() user: AuthUser, @Param('id') sessionId: string, @Query() query: PreviewBuildQueryDto) {
    return this.preview.builds(user.id, sessionId, query);
  }

  @Post('builds/:buildId/cancel')
  @RequirePermissions(PERMISSIONS.GENERATE)
  cancelBuild(
    @CurrentUser() user: AuthUser,
    @Param('id') sessionId: string,
    @Param('buildId') buildId: string,
  ) {
    return this.preview.cancelBuild(user.id, sessionId, buildId);
  }

  @Get('builds/metrics')
  buildMetrics(
    @CurrentUser() user: AuthUser,
    @Param('id') sessionId: string,
    @Query('days') days?: string,
  ) {
    return this.preview.buildMetrics(user.id, sessionId, Number(days) || 7);
  }

  /** 后端项目：解析出的 API 端点列表 */
  @Get('endpoints')
  endpoints(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    return this.preview.endpoints(user.id, sessionId);
  }

  /** 后端项目：代理转发一次请求到运行中的服务（在线调试） */
  @Post('request')
  request(
    @CurrentUser() user: AuthUser,
    @Param('id') sessionId: string,
    @Body() body: ProxyRequestDto,
  ) {
    return this.preview.proxyRequest(user.id, sessionId, body);
  }
}
