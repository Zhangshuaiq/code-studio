import { Global, Module } from '@nestjs/common';
import { MonitoringConfigController } from './monitoring-config.controller';
import { MonitoringConfigService } from './monitoring-config.service';

@Global()
@Module({ controllers: [MonitoringConfigController], providers: [MonitoringConfigService], exports: [MonitoringConfigService] })
export class MonitoringConfigModule {}
