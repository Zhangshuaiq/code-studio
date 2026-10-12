import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { auditActorContext } from '../audit/audit.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { AcceptOrganizationInvitationDto, AddOrganizationMemberDto, CreateOrganizationDto, CreateOrganizationInvitationDto, UpdateEnterprisePolicyDto } from './dto/enterprise-policy.dto';
import { EnterprisePolicyService } from './enterprise-policy.service';
import { OrganizationDomainDto, OrganizationAuditQueryDto, UpdateOrganizationMemberRoleDto, UpdateManagedEnterprisePolicyDto } from './dto/enterprise-policy.dto';
import { Audit } from '../audit/audit.decorator';

function requestAuditContext(request: Request, user: AuthUser) {
  // Express request fields such as ip are prototype getters, not spread fields.
  return auditActorContext({ user, ip: request.ip, socket: request.socket, method: request.method, originalUrl: request.originalUrl, url: request.url });
}

@UseGuards(JwtAuthGuard)
@Controller('control/enterprise')
export class EnterprisePolicyController {
  constructor(private readonly service: EnterprisePolicyService) {}
  @Get('policy') policy(@CurrentUser() user: AuthUser) { return this.service.issueForUser(user.id); }
  @Post('invitations/accept') @Audit('organization.invitation.accept', 'organization', false, [], { userId: 'membership.userId', role: 'membership.role' }, true) acceptInvitation(@CurrentUser() user: AuthUser, @Body() body: AcceptOrganizationInvitationDto, @Req() request: Request) { return this.service.acceptInvitation(user, body.token, requestAuditContext(request, user)); }
  @Get('organizations') myOrganizations(@CurrentUser() user: AuthUser) { return this.service.myOrganizations(user.id); }
  @Get('organizations/:id/members') managedMembers(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.service.managedMembers(id, user.id); }
  @Get('organizations/:id/audit') audit(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() query: OrganizationAuditQueryDto) { return this.service.organizationAudit(id, user.id, query); }
  @Get('organizations/:id/policy') managedPolicy(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.service.managedPolicy(id, user.id); }
  @Put('organizations/:id/policy') @Audit('organization.policy.update', 'organization', false, [], {}, true) updateManagedPolicy(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: UpdateManagedEnterprisePolicyDto, @Req() request: Request) { return this.service.updatePolicy(id, body, user.id, body.expectedUpdatedAt, requestAuditContext(request, user)); }
  @Get('organizations/:id/domains') managedDomains(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.service.domains(id, user.id); }
  @Post('organizations/:id/domains') @Audit('organization.domain.create', 'organization', false, [], { domainId: 'id' }, true) createManagedDomain(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: OrganizationDomainDto, @Req() request: Request) { return this.service.createDomain(id, body.domain, user.id, requestAuditContext(request, user)); }
  @Post('organizations/:id/domains/:domainId/verify') @Audit('organization.domain.verify', 'organization', false, ['domainId'], {}, true) verifyManagedDomain(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('domainId') domainId: string, @Req() request: Request) { return this.service.verifyDomain(id, domainId, user.id, requestAuditContext(request, user)); }
  @Delete('organizations/:id/domains/:domainId') @Audit('organization.domain.remove', 'organization', false, ['domainId'], {}, true) removeManagedDomain(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('domainId') domainId: string, @Req() request: Request) { return this.service.removeDomain(id, domainId, user.id, requestAuditContext(request, user)); }
  @Put('organizations/:id/members/:userId/role') @Audit('organization.member.role.update', 'organization', false, ['userId'], { role: 'role' }, true) changeRole(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string, @Body() body: UpdateOrganizationMemberRoleDto, @Req() request: Request) { return this.service.updateMemberRole(id, userId, body.role, user.id, requestAuditContext(request, user)); }
  @Delete('organizations/:id/members/:userId') @Audit('organization.member.remove', 'organization', false, ['userId'], {}, true) removeManagedMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string, @Req() request: Request) { return this.service.removeMember(id, userId, user.id, requestAuditContext(request, user)); }
  @Get('organizations/:id/invitations') managedInvitations(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.service.invitations(id, user.id); }
  @Post('organizations/:id/invitations') @Audit('organization.invitation.create', 'organization', false, [], { invitationId: 'id', role: 'role' }, true) inviteMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: CreateOrganizationInvitationDto, @Req() request: Request) { return this.service.createInvitation(id, user.id, body, user.id, requestAuditContext(request, user)); }
  @Delete('organizations/:id/invitations/:invitationId') @Audit('organization.invitation.revoke', 'organization', false, ['invitationId'], {}, true) revokeManagedInvitation(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('invitationId') invitationId: string, @Req() request: Request) { return this.service.revokeInvitation(id, invitationId, user.id, requestAuditContext(request, user)); }
}
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.ADMIN_USERS)
@Controller('admin/organizations')
export class EnterprisePolicyAdminController {
  constructor(private readonly service: EnterprisePolicyService) {}
  @Get() organizations() { return this.service.organizations(); }
  @Post() @Audit('organization.create', 'organization', false, [], {}, true) create(@CurrentUser() user: AuthUser, @Body() body: CreateOrganizationDto, @Req() request: Request) { return this.service.createOrganization(body, requestAuditContext(request, user)); }
  @Get(':id/members') members(@Param('id') id: string) { return this.service.members(id); }
  @Post(':id/members') @Audit('organization.member.add', 'organization', false, [], { userId: 'userId', role: 'role' }, true) addMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: AddOrganizationMemberDto, @Req() request: Request) { return this.service.addMember(id, body, requestAuditContext(request, user)); }
  @Delete(':id/members/:userId') @Audit('organization.member.remove', 'organization', false, ['userId'], {}, true) removeMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string, @Req() request: Request) { return this.service.removeMember(id, userId, undefined, requestAuditContext(request, user)); }
  @Put(':id/members/:userId/role') @Audit('organization.member.role.update', 'organization', false, ['userId'], { role: 'role' }, true) changeRole(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string, @Body() body: UpdateOrganizationMemberRoleDto, @Req() request: Request) { return this.service.updateMemberRole(id, userId, body.role, undefined, requestAuditContext(request, user)); }
  @Get(':id/invitations') invitations(@Param('id') id: string) { return this.service.invitations(id); }
  @Get(':id/domains') domains(@Param('id') id: string) { return this.service.domains(id); }
  @Post(':id/domains') @Audit('organization.domain.create', 'organization', false, [], { domainId: 'id' }, true) createDomain(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: OrganizationDomainDto, @Req() request: Request) { return this.service.createDomain(id, body.domain, undefined, requestAuditContext(request, user)); }
  @Post(':id/domains/:domainId/verify') @Audit('organization.domain.verify', 'organization', false, ['domainId'], {}, true) verifyDomain(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('domainId') domainId: string, @Req() request: Request) { return this.service.verifyDomain(id, domainId, undefined, requestAuditContext(request, user)); }
  @Delete(':id/domains/:domainId') @Audit('organization.domain.remove', 'organization', false, ['domainId'], {}, true) removeDomain(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('domainId') domainId: string, @Req() request: Request) { return this.service.removeDomain(id, domainId, undefined, requestAuditContext(request, user)); }
  @Post(':id/invitations') @Audit('organization.invitation.create', 'organization', false, [], { invitationId: 'id', role: 'role' }, true) invite(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: CreateOrganizationInvitationDto, @Req() request: Request) { return this.service.createInvitation(id, user.id, body, undefined, requestAuditContext(request, user)); }
  @Delete(':id/invitations/:invitationId') @Audit('organization.invitation.revoke', 'organization', false, ['invitationId'], {}, true) revokeInvitation(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('invitationId') invitationId: string, @Req() request: Request) { return this.service.revokeInvitation(id, invitationId, undefined, requestAuditContext(request, user)); }
  @Put(':id/policy') @Audit('organization.policy.update', 'organization', false, [], {}, true) updatePolicy(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: UpdateEnterprisePolicyDto, @Req() request: Request) { return this.service.updatePolicy(id, body, undefined, undefined, requestAuditContext(request, user)); }
}
