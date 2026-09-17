import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { PermissionsGuard } from '../auth/permissions.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { Audit } from '../audit/audit.decorator';
import { ProjectService } from './project.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { SetProjectRepositoryDto } from './dto/set-project-repository.dto';
import { ProjectMemberRoleDto, ProjectMembersDto } from './dto/project-members.dto';
import { PageQueryDto } from '../common/dto/page-query.dto';
import { DeleteProjectDto } from './dto/delete-project.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.PROJECT_READ)
@Controller('projects')
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit('project.create', 'project')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user.id, dto);
  }

  @Post(':id/import/retry')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit('project.git-import.retry', 'project')
  retryImport(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.retryImport(user.id, id);
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: PageQueryDto) {
    return this.projects.findAll(user.id, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.findOne(user.id, id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(user.id, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit('project.delete', 'project')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: DeleteProjectDto) {
    return this.projects.remove(user.id, id, body?.cleanupDeployment === true);
  }

  @Get(':id/repository')
  getRepository(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.getRepository(user.id, id);
  }

  @Put(':id/repository')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit('project.git-remote.update', 'project')
  setRepository(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetProjectRepositoryDto,
  ) {
    return this.projects.setRepository(user.id, id, dto);
  }

  @Delete(':id/repository')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit('project.git-remote.delete', 'project')
  removeRepository(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.removeRepository(user.id, id);
  }

  @Post(':id/members')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit('project.add-members', 'project')
  addMembers(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ProjectMembersDto,
  ) {
    return this.projects.addMembers(user.id, id, body.userIds, body.role);
  }

  @Delete(':id/members')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit('project.remove-members', 'project')
  removeMembers(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ProjectMembersDto,
  ) {
    return this.projects.removeMembers(user.id, id, body.userIds);
  }

  @Patch(':id/members/:userId')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit('project.member-role.update', 'project')
  updateMemberRole(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') memberUserId: string,
    @Body() body: ProjectMemberRoleDto,
  ) {
    return this.projects.updateMemberRole(user.id, id, memberUserId, body.role);
  }
}
