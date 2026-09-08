import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { Audit } from '../audit/audit.decorator';
import { PageQueryDto } from '../common/dto/page-query.dto';
import { AddRequirementProjectDto, CreateRequirementDto, RequirementQueryDto, SaveRequirementDocumentDto, UpdateRequirementDto, UpdateRequirementProjectDto, UpdateRequirementStageDto } from './dto/requirement.dto';
import { RequirementService } from './requirement.service';

@Controller('requirements')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RequirementController {
  constructor(private readonly requirements: RequirementService) {}
  @Get() @RequirePermissions(PERMISSIONS.REQUIREMENT_READ) list(@CurrentUser() user: AuthUser, @Query() query: RequirementQueryDto) { return this.requirements.list(user.id, query); }
  @Get('metadata') @RequirePermissions(PERMISSIONS.REQUIREMENT_READ) metadata(@CurrentUser() user: AuthUser) { return this.requirements.metadata(user.id); }
  @Get(':id') @RequirePermissions(PERMISSIONS.REQUIREMENT_READ) detail(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.requirements.detail(user.id, id); }
  @Post() @RequirePermissions(PERMISSIONS.REQUIREMENT_MANAGE) @Audit('requirement.create', 'requirement') create(@CurrentUser() user: AuthUser, @Body() body: CreateRequirementDto) { return this.requirements.create(user.id, body); }
  @Patch(':id') @RequirePermissions(PERMISSIONS.REQUIREMENT_MANAGE) @Audit('requirement.update', 'requirement') update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: UpdateRequirementDto) { return this.requirements.update(user, id, body); }
  @Put(':id/document') @RequirePermissions(PERMISSIONS.REQUIREMENT_MANAGE) @Audit('requirement.document.save', 'requirement') document(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: SaveRequirementDocumentDto) { return this.requirements.saveDocument(user, id, body); }
  @Get(':id/revisions') @RequirePermissions(PERMISSIONS.REQUIREMENT_READ) revisions(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() query: PageQueryDto) { return this.requirements.revisions(user.id, id, query); }
  @Patch(':id/stages/:stageId') @RequirePermissions(PERMISSIONS.REQUIREMENT_STAGE_UPDATE) @Audit('requirement.stage.update', 'requirement-stage') stage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('stageId') stageId: string, @Body() body: UpdateRequirementStageDto) { return this.requirements.updateStage(user, id, stageId, body); }
  @Post(':id/projects') @RequirePermissions(PERMISSIONS.REQUIREMENT_MANAGE) @Audit('requirement.project.add', 'requirement-project') addProject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: AddRequirementProjectDto) { return this.requirements.addProject(user, id, body); }
  @Patch(':id/projects/:linkId') @RequirePermissions(PERMISSIONS.REQUIREMENT_MANAGE) @Audit('requirement.project.update', 'requirement-project') updateProject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('linkId') linkId: string, @Body() body: UpdateRequirementProjectDto) { return this.requirements.updateProject(user, id, linkId, body); }
  @Post(':id/projects/:linkId/branch') @RequirePermissions(PERMISSIONS.REQUIREMENT_MANAGE) @Audit('requirement.branch.create', 'requirement-project') createProjectBranch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('linkId') linkId: string) { return this.requirements.createProjectBranch(user.id, id, linkId); }
  @Delete(':id/projects/:linkId') @RequirePermissions(PERMISSIONS.REQUIREMENT_MANAGE) @Audit('requirement.project.remove', 'requirement-project') removeProject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('linkId') linkId: string) { return this.requirements.removeProject(user, id, linkId); }
}
