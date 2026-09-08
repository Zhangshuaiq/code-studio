import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Audit } from '../audit/audit.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PERMISSIONS } from '../auth/permissions';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CryptoRotationService } from './crypto-rotation.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
@Controller('admin/encryption')
export class CryptoAdminController {
  constructor(private readonly rotation: CryptoRotationService) {}

  @Get('status')
  status() {
    return this.rotation.status();
  }

  @Post('rotate')
  @Audit('encryption.rotate', 'system-setting')
  rotate() {
    return this.rotation.rotateAll();
  }
}
