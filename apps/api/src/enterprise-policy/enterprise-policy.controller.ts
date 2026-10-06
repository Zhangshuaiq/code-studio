import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { AcceptOrganizationInvitationDto, AddOrganizationMemberDto, CreateOrganizationDto, CreateOrganizationInvitationDto, UpdateEnterprisePolicyDto } from './dto/enterprise-policy.dto';
import { EnterprisePolicyService } from './enterprise-policy.service';
import { OrganizationDomainDto } from './dto/enterprise-policy.dto';

@UseGuards(JwtAuthGuard)
@Controller('control/enterprise')
export class EnterprisePolicyController {
  constructor(private readonly service: EnterprisePolicyService) {}
  @Get('policy') policy(@CurrentUser() user: AuthUser) { return this.service.issueForUser(user.id); }
  @Post('invitations/accept') acceptInvitation(@CurrentUser() user: AuthUser, @Body() body: AcceptOrganizationInvitationDto) { return this.service.acceptInvitation(user, body.token); }
}
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.ADMIN_USERS)
@Controller('admin/organizations')
export class EnterprisePolicyAdminController {
  constructor(private readonly service: EnterprisePolicyService) {}
  @Get() organizations() { return this.service.organizations(); }
  @Post() create(@Body() body: CreateOrganizationDto) { return this.service.createOrganization(body); }
  @Get(':id/members') members(@Param('id') id: string) { return this.service.members(id); }
  @Post(':id/members') addMember(@Param('id') id: string, @Body() body: AddOrganizationMemberDto) { return this.service.addMember(id, body); }
  @Delete(':id/members/:userId') removeMember(@Param('id') id: string, @Param('userId') userId: string) { return this.service.removeMember(id, userId); }
  @Get(':id/invitations') invitations(@Param('id') id: string) { return this.service.invitations(id); }
  @Get(':id/domains') domains(@Param('id') id: string) { return this.service.domains(id); }
  @Post(':id/domains') createDomain(@Param('id') id: string, @Body() body: OrganizationDomainDto) { return this.service.createDomain(id, body.domain); }
  @Post(':id/domains/:domainId/verify') verifyDomain(@Param('id') id: string, @Param('domainId') domainId: string) { return this.service.verifyDomain(id, domainId); }
  @Delete(':id/domains/:domainId') removeDomain(@Param('id') id: string, @Param('domainId') domainId: string) { return this.service.removeDomain(id, domainId); }
  @Post(':id/invitations') invite(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: CreateOrganizationInvitationDto) { return this.service.createInvitation(id, user.id, body); }
  @Delete(':id/invitations/:invitationId') revokeInvitation(@Param('id') id: string, @Param('invitationId') invitationId: string) { return this.service.revokeInvitation(id, invitationId); }
  @Put(':id/policy') updatePolicy(@Param('id') id: string, @Body() body: UpdateEnterprisePolicyDto) { return this.service.updatePolicy(id, body); }
}
