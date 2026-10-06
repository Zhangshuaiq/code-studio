import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { ActivateLicenseDto, AssignSubscriptionDto, CreateRedeemCodeDto, IssueOfflineLicenseDto, RedeemLicenseDto } from './dto/license.dto';
import { LicenseService } from './license.service';

@UseGuards(JwtAuthGuard)
@Controller('control/license')
export class LicenseController {
  constructor(private readonly licenses: LicenseService) {}
  @Get('subscription') subscription(@CurrentUser() user: AuthUser) { return this.licenses.subscription(user.id); }
  @Get('devices') devices(@CurrentUser() user: AuthUser) { return this.licenses.devices(user.id); }
  @Post('activate') activate(@CurrentUser() user: AuthUser, @Body() body: ActivateLicenseDto) { return this.licenses.activate(user.id, body); }
  @Post('redeem') redeem(@CurrentUser() user: AuthUser, @Body() body: RedeemLicenseDto) { return this.licenses.redeem(user.id, body.code); }
  @Delete('devices/:id') revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.licenses.revoke(user.id, id); }
}

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.ADMIN_USERS)
@Controller('admin/licenses')
export class LicenseAdminController {
  constructor(private readonly licenses: LicenseService) {}
  @Get('subscriptions') subscriptions() { return this.licenses.listSubscriptions(); }
  @Post('subscriptions') assign(@Body() body: AssignSubscriptionDto) { return this.licenses.assign(body); }
  @Get('redeem-codes') listCodes() { return this.licenses.listRedeemCodes(); }
  @Post('redeem-codes') createCode(@Body() body: CreateRedeemCodeDto) { return this.licenses.createRedeemCode(body); }
  @Delete('redeem-codes/:id') disableCode(@Param('id') id: string) { return this.licenses.disableRedeemCode(id); }
  @Post('offline-license') offline(@Body() body: IssueOfflineLicenseDto) { return this.licenses.issueOffline(body.userId, body.challenge); }
}
