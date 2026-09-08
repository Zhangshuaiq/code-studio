import { Module } from '@nestjs/common';
import { ResourceMetricsController } from './resource-metrics.controller';
import { ResourceMetricsService } from './resource-metrics.service';
import { DeployModule } from '../deploy/deploy.module';

@Module({ imports: [DeployModule], controllers: [ResourceMetricsController], providers: [ResourceMetricsService], exports: [ResourceMetricsService] })
export class ResourceMetricsModule {}
