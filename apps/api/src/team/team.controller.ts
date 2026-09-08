import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { Audit } from '../audit/audit.decorator';
import { TeamService } from './team.service';
import { AddMembersDto, CreateTeamDto, UpdateTeamDto } from './dto/team.dto';
import { PageQueryDto } from '../common/dto/page-query.dto';

@Controller('admin/teams')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  listTeams(@Query() query: PageQueryDto) {
    return this.team.listTeams(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  getTeam(@Param('id') id: string) {
    return this.team.getTeam(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  @Audit('team.create', 'team')
  createTeam(@Body() body: CreateTeamDto) {
    return this.team.createTeam(body);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  @Audit('team.update', 'team')
  updateTeam(@Param('id') id: string, @Body() body: UpdateTeamDto) {
    return this.team.updateTeam(id, body);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  @Audit('team.delete', 'team')
  deleteTeam(@Param('id') id: string) {
    return this.team.deleteTeam(id);
  }

  @Post(':id/members')
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  @Audit('team.add-members', 'team')
  addMembers(@Param('id') id: string, @Body() body: AddMembersDto) {
    return this.team.addMembers(id, body);
  }

  @Delete(':id/members')
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  @Audit('team.remove-members', 'team')
  removeMembers(@Param('id') id: string, @Body() body: AddMembersDto) {
    return this.team.removeMembers(id, body);
  }
}
