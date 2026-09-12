import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { ProjectAccessModule } from './project-access/project-access.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { GitModule } from './git/git.module';
import { AgentModule } from './agent/agent.module';
import { AgentWorkerService } from './agent/agent-worker.service';
import { environmentConfigOptions } from './config/environment';
import { ScheduledTaskModule } from './scheduled-task/scheduled-task.module';
import { ScheduledTaskWorkerService } from './scheduled-task/scheduled-task-worker.service';
import { ScheduledTaskDispatcherService } from './scheduled-task/scheduled-task-dispatcher.service';
import { DbQueryModule } from './db-query/db-query.module';
import { DatabaseTransferDispatcherService } from './db-query/database-transfer-dispatcher.service';
import { ProjectCleanupWorkerService } from './project/project-cleanup-worker.service';
import { BusinessLogModule } from './business-log/business-log.module';
import { PreviewModule } from './preview/preview.module';
import { ProjectModule } from './project/project.module';
import { ProjectImportWorkerService } from './project/project-import-worker.service';

@Module({
  imports: [
    ConfigModule.forRoot(environmentConfigOptions),
    PrismaModule,
    CryptoModule,
    ProjectAccessModule,
    WorkspaceModule,
    GitModule,
    AgentModule,
    ScheduledTaskModule,
    DbQueryModule,
    BusinessLogModule,
    PreviewModule,
    ProjectModule,
  ],
  providers: [AgentWorkerService, ScheduledTaskWorkerService, ScheduledTaskDispatcherService, DatabaseTransferDispatcherService, ProjectCleanupWorkerService, ProjectImportWorkerService],
})
export class WorkerAppModule {}
