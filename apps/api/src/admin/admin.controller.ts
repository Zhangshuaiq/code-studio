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
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { PERMISSIONS } from '../auth/permissions';
import { Audit } from '../audit/audit.decorator';
import { AdminService } from './admin.service';
import { AcknowledgeProjectCleanupDto, CreateAdminUserDto, CreateRoleDto, ProjectCleanupListQueryDto, ProjectImportListQueryDto, ResetPasswordDto, UpdateAdminUserDto, UpdateRoleDto } from './dto/admin.dto';
import { PageQueryDto } from '../common/dto/page-query.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ---- 用户 ----
  @Get('users')
  @RequirePermissions(PERMISSIONS.ADMIN_USERS)
  listUsers(@Query() query: PageQueryDto) {
    return this.admin.listUsers(query);
  }

  @Post('users')
  @RequirePermissions(PERMISSIONS.ADMIN_USERS)
  @Audit('user.create', 'user')
  createUser(@Body() body: CreateAdminUserDto) {
    return this.admin.createUser(body);
  }

  @Patch('users/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_USERS)
  @Audit('user.update', 'user')
  updateUser(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateAdminUserDto,
  ) {
    return this.admin.updateUser(actor.id, id, body);
  }

  @Post('users/:id/reset-password')
  @RequirePermissions(PERMISSIONS.ADMIN_USERS)
  @Audit('user.reset-password', 'user')
  resetPassword(@Param('id') id: string, @Body() body: ResetPasswordDto) {
    return this.admin.resetPassword(id, body.password);
  }

  @Delete('users/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_USERS)
  @Audit('user.delete', 'user')
  deleteUser(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.admin.deleteUser(actor.id, id);
  }

  // ---- 角色 / 权限 ----
  @Get('roles')
  @RequirePermissions(PERMISSIONS.ADMIN_ROLES)
  listRoles(@Query() query: PageQueryDto) {
    return this.admin.listRoles(query);
  }

  @Get('permissions')
  @RequirePermissions(PERMISSIONS.ADMIN_ROLES)
  permissions() {
    return this.admin.permissionCatalog();
  }

  @Post('roles')
  @RequirePermissions(PERMISSIONS.ADMIN_ROLES)
  @Audit('role.create', 'role')
  createRole(
    @Body() body: CreateRoleDto,
  ) {
    return this.admin.createRole(body);
  }

  @Patch('roles/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_ROLES)
  @Audit('role.update', 'role')
  updateRole(
    @Param('id') id: string,
    @Body() body: UpdateRoleDto,
  ) {
    return this.admin.updateRole(id, body);
  }

  @Delete('roles/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_ROLES)
  @Audit('role.delete', 'role')
  deleteRole(@Param('id') id: string) {
    return this.admin.deleteRole(id);
  }

  @Get('project-cleanups')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  projectCleanups(@Query() query: ProjectCleanupListQueryDto) {
    return this.admin.listProjectCleanups(query);
  }

  @Post('project-cleanups/:id/retry')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  @Audit('project.cleanup.retry', 'project')
  retryProjectCleanup(@Param('id') id: string) {
    return this.admin.retryProjectCleanup(id);
  }

  @Patch('project-cleanups/:id/acknowledge')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  @Audit('project.cleanup.acknowledge', 'project')
  acknowledgeProjectCleanup(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: AcknowledgeProjectCleanupDto,
  ) {
    return this.admin.acknowledgeProjectCleanup(actor, id, body.note);
  }

  @Get('project-imports')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  projectImports(@Query() query: ProjectImportListQueryDto) {
    return this.admin.listProjectImports(query);
  }

  @Post('project-imports/:id/retry')
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  @Audit('project.git-import.admin-retry', 'project')
  retryProjectImport(@Param('id') id: string) {
    return this.admin.retryProjectImport(id);
  }
}
