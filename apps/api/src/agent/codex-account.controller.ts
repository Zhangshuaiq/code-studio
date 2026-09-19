import { Controller, Delete, Get, Header, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { Audit } from '../audit/audit.decorator';
import { CodexAccountService } from './codex-account.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.MODEL_MANAGE)
@Controller('codex-account')
export class CodexAccountController {
  constructor(private readonly accounts: CodexAccountService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.accounts.status(user.id);
  }

  @Get('host-login')
  @Header('Cache-Control', 'no-store')
  hostLoginStatus() {
    return this.accounts.hostLoginStatus();
  }

  @Post('bind-host')
  @Header('Cache-Control', 'no-store')
  @Audit('codex-account.bind-host', 'codex-account')
  bindHostLogin(@CurrentUser() user: AuthUser) {
    return this.accounts.bindHostLogin(user.id);
  }

  @Post('device-login')
  @Header('Cache-Control', 'no-store')
  @Audit('codex-account.login', 'codex-account')
  beginLogin(@CurrentUser() user: AuthUser) {
    return this.accounts.beginLogin(user.id);
  }

  @Delete()
  @Audit('codex-account.logout', 'codex-account')
  disconnect(@CurrentUser() user: AuthUser) {
    return this.accounts.disconnect(user.id);
  }
}
