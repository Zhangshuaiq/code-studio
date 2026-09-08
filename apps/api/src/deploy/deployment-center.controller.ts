import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { PERMISSIONS } from "../auth/permissions";
import { CurrentUser } from "../auth/current-user.decorator";
import { AuthUser } from "../auth/jwt.strategy";
import { Audit } from "../audit/audit.decorator";
import { DeploymentCenterService } from "./deployment-center.service";
import { DeploymentRecordQueryDto, RunDeploymentDto, SaveRuntimeBindingDto } from "./dto/deployment-center.dto";

@Controller("deployment-center")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.PROJECT_READ)
export class DeploymentCenterController {
  constructor(private readonly center: DeploymentCenterService) {}

  @Get("projects")
  projects(@CurrentUser() user: AuthUser) {
    return this.center.projects(user.id);
  }

  @Get("projects/:id/branches")
  branches(@CurrentUser() user: AuthUser, @Param("id") projectId: string) {
    return this.center.branches(user.id, projectId);
  }

  @Get("projects/:id/bindings")
  bindings(@CurrentUser() user: AuthUser, @Param("id") projectId: string) {
    return this.center.bindings(user.id, projectId);
  }

  @Get("projects/:id/status")
  status(@CurrentUser() user: AuthUser, @Param("id") projectId: string) {
    return this.center.status(user.id, projectId);
  }

  @Post("bindings")
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE)
  @Audit("project-runtime-binding.save", "project")
  saveBinding(@CurrentUser() user: AuthUser, @Body() body: SaveRuntimeBindingDto) {
    return this.center.saveBinding(user.id, body);
  }

  @Delete("bindings/:id")
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE)
  @Audit("project-runtime-binding.delete", "project")
  removeBinding(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.center.removeBinding(user.id, id);
  }

  @Post("deploy")
  @RequirePermissions(PERMISSIONS.DEPLOY_EXECUTE)
  @Audit("deploy.execute", "deployment")
  deploy(@CurrentUser() user: AuthUser, @Body() body: RunDeploymentDto) {
    return this.center.run(user.id, user.username, body);
  }

  @Get("records")
  records(
    @CurrentUser() user: AuthUser,
    @Query() query: DeploymentRecordQueryDto,
  ) {
    return this.center.records(user.id, query);
  }

  @Post("projects/:id/stop")
  @RequirePermissions(PERMISSIONS.DEPLOY_EXECUTE)
  @Audit("deploy.stop", "deployment")
  stop(@CurrentUser() user: AuthUser, @Param("id") projectId: string) {
    return this.center.stop(user.id, projectId);
  }
}
