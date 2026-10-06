import { Module } from '@nestjs/common';
import { LicenseAdminController, LicenseController } from './license.controller';
import { LicenseService } from './license.service';

@Module({ controllers: [LicenseController, LicenseAdminController], providers: [LicenseService], exports: [LicenseService] })
export class LicenseModule {}
