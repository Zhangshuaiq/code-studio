import { Module } from '@nestjs/common';
import { EnterprisePolicyAdminController, EnterprisePolicyController } from './enterprise-policy.controller';
import { EnterprisePolicyService } from './enterprise-policy.service';

@Module({ controllers: [EnterprisePolicyController, EnterprisePolicyAdminController], providers: [EnterprisePolicyService] })
export class EnterprisePolicyModule {}
