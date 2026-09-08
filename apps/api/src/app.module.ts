import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { CryptoModule } from "./crypto/crypto.module";
import { AuthModule } from "./auth/auth.module";
import { ProjectModule } from "./project/project.module";
import { SessionModule } from "./session/session.module";
import { ModelConfigModule } from "./model-config/model-config.module";
import { SandboxModule } from "./sandbox/sandbox.module";
import { AgentModule } from "./agent/agent.module";
import { PreviewModule } from "./preview/preview.module";
import { FilesModule } from "./files/files.module";
import { GitModule } from "./git/git.module";
import { DeployModule } from "./deploy/deploy.module";
import { AdminModule } from "./admin/admin.module";
import { AuditModule } from "./audit/audit.module";
import { TeamModule } from "./team/team.module";
import { DatasourceModule } from "./datasource/datasource.module";
import { DbQueryModule } from "./db-query/db-query.module";
import { K8sModule } from "./k8s/k8s.module";
import { BusinessLogModule } from "./business-log/business-log.module";
import { ProjectAccessModule } from "./project-access/project-access.module";
import { WorkspaceModule } from "./workspace/workspace.module";
import { PlatformHealthModule } from "./platform-health/platform-health.module";
import { ApiMetricsModule } from "./api-metrics/api-metrics.module";
import { environmentConfigOptions } from "./config/environment";
import { requestContextMiddleware } from "./observability/request-context";
import { RateLimitModule } from "./rate-limit/rate-limit.module";
import { ScheduledTaskModule } from "./scheduled-task/scheduled-task.module";
import { TracingModule } from "./tracing/tracing.module";
import { ResourceMetricsModule } from "./resource-metrics/resource-metrics.module";
import { KafkaModule } from "./kafka/kafka.module";
import { RequirementModule } from "./requirement/requirement.module";
import { McpModule } from "./mcp/mcp.module";
import { McpApprovalModule } from "./mcp-approval/mcp-approval.module";
import { LspModule } from "./lsp/lsp.module";

@Module({
  imports: [
    ConfigModule.forRoot(environmentConfigOptions),
    PrismaModule,
    CryptoModule,
    ProjectAccessModule,
    WorkspaceModule,
    AuthModule,
    ProjectModule,
    SessionModule,
    ModelConfigModule,
    SandboxModule,
    AgentModule,
    PreviewModule,
    FilesModule,
    GitModule,
    DeployModule,
    AdminModule,
    AuditModule,
    TeamModule,
    DatasourceModule,
    DbQueryModule,
    K8sModule,
    BusinessLogModule,
    PlatformHealthModule,
    ApiMetricsModule,
    RateLimitModule,
    ScheduledTaskModule,
    TracingModule,
    ResourceMetricsModule,
    KafkaModule,
    RequirementModule,
    McpApprovalModule,
    McpModule,
    LspModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(requestContextMiddleware).forRoutes('*');
  }
}
