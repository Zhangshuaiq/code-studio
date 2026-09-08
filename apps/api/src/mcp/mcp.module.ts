import { Module } from '@nestjs/common';
import { PlatformHealthModule } from '../platform-health/platform-health.module';
import { ProjectModule } from '../project/project.module';
import { RequirementModule } from '../requirement/requirement.module';
import { McpController } from './mcp.controller';
import { McpEnabledGuard } from './mcp-enabled.guard';
import { McpInvocationService } from './mcp-invocation.service';
import { McpServerFactory } from './mcp-server.factory';
import { McpToolCatalogService } from './mcp-tool-catalog.service';
import { WorkspaceMcpFacade } from '../workspace/workspace-mcp.facade';
import { GitModule } from '../git/git.module';
import { ProjectAccessModule } from '../project-access/project-access.module';
import { WorkspaceFileMcpFacade } from '../workspace/workspace-file-mcp.facade';
import { DeployModule } from '../deploy/deploy.module';
import { PreviewModule } from '../preview/preview.module';
import { RuntimeStatusMcpFacade } from './runtime-status-mcp.facade';
import { K8sModule } from '../k8s/k8s.module';
import { K8sMcpFacade } from './k8s-mcp.facade';
import { KafkaModule } from '../kafka/kafka.module';
import { KafkaMcpFacade } from './kafka-mcp.facade';
import { DatasourceModule } from '../datasource/datasource.module';
import { DbQueryModule } from '../db-query/db-query.module';
import { DatabaseMcpFacade } from './database-mcp.facade';
import { ScheduledTaskModule } from '../scheduled-task/scheduled-task.module';
import { BusinessLogModule } from '../business-log/business-log.module';
import { ScheduledTaskMcpFacade } from './scheduled-task-mcp.facade';
import { BusinessLogMcpFacade } from './business-log-mcp.facade';
import { TracingModule } from '../tracing/tracing.module';
import { TracingMcpFacade } from './tracing-mcp.facade';
import { McpApprovalModule } from '../mcp-approval/mcp-approval.module';

@Module({
  imports: [PlatformHealthModule, ProjectModule, RequirementModule, GitModule, ProjectAccessModule, PreviewModule, DeployModule, K8sModule, KafkaModule, DatasourceModule, DbQueryModule, ScheduledTaskModule, BusinessLogModule, TracingModule, McpApprovalModule],
  controllers: [McpController],
  providers: [McpEnabledGuard, McpInvocationService, WorkspaceMcpFacade, WorkspaceFileMcpFacade, RuntimeStatusMcpFacade, K8sMcpFacade, KafkaMcpFacade, DatabaseMcpFacade, ScheduledTaskMcpFacade, BusinessLogMcpFacade, TracingMcpFacade, McpToolCatalogService, McpServerFactory],
})
export class McpModule {}
