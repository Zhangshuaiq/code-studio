import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { AuthUser } from "../auth/jwt.strategy";
import { Audit } from "../audit/audit.decorator";
import { DeployTargetService } from "./deploy-target.service";
import { PermissionsGuard } from "../auth/permissions.guard";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { PERMISSIONS } from "../auth/permissions";
import { CreateDeployTargetDto, UpdateDeployTargetDto } from "./dto/deploy-target.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE)
@Controller("deploy-targets")
export class DeployTargetController {
  constructor(private readonly targets: DeployTargetService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE)
  @Audit("deploy-target.create", "deploy-target")
  create(@CurrentUser() user: AuthUser, @Body() body: CreateDeployTargetDto) {
    return this.targets.create(user.id, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query("purpose") purpose?: string) {
    return this.targets.list(user.id, purpose);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.targets.get(user.id, id);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE)
  @Audit("deploy-target.delete", "deploy-target")
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.targets.remove(user.id, id);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.DEPLOY_TARGET_MANAGE)
  @Audit("deploy-target.update", "deploy-target")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: UpdateDeployTargetDto,
  ) {
    return this.targets.update(user.id, id, body);
  }
}
