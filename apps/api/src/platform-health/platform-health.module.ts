import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { BusinessLogModule } from '../business-log/business-log.module';
import { PlatformHealthController } from './platform-health.controller';
import { PlatformHealthService } from './platform-health.service';
import { ProjectAccessModule } from '../project-access/project-access.module';
import { HealthProbeController } from './health-probe.controller';
import { TracingModule } from '../tracing/tracing.module';
import { ResourceMetricsModule } from '../resource-metrics/resource-metrics.module';

@Module({
  imports: [AgentModule, SandboxModule, BusinessLogModule, ProjectAccessModule, TracingModule, ResourceMetricsModule],
  controllers: [PlatformHealthController, HealthProbeController],
  providers: [PlatformHealthService],
  exports: [PlatformHealthService],
})
export class PlatformHealthModule {}
