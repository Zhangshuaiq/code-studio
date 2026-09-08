import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { Audit } from '../audit/audit.decorator';
import { DeployService } from './deploy.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { RunDeployDto } from './dto/run-deploy.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.PROJECT_READ)
@Controller('sessions/:id/deploy')
export class DeployController {
  constructor(private readonly deploy: DeployService) {}

  /** 触发部署（构建镜像 + 起容器，异步）。body.targetId 指定目标，缺省=本机 Docker */
  @Post()
  @RequirePermissions(PERMISSIONS.DEPLOY_EXECUTE)
  @Audit('deploy.execute', 'deployment')
  run(
    @CurrentUser() user: AuthUser,
    @Param('id') sessionId: string,
    @Body() body: RunDeployDto = {},
  ) {
    return this.deploy.deploy(user.id, sessionId, body.targetId);
  }

  /** 部署状态 + 日志 + URL */
  @Get()
  status(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    return this.deploy.get(user.id, sessionId);
  }

  /** 停止部署 */
  @Post('stop')
  @RequirePermissions(PERMISSIONS.DEPLOY_EXECUTE)
  @Audit('deploy.stop', 'deployment')
  stop(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    return this.deploy.stop(user.id, sessionId);
  }
}
