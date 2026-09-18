import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { environmentConfigOptions } from './config/environment';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { ProjectAccessModule } from './project-access/project-access.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { GitModule } from './git/git.module';
import { AgentModule } from './agent/agent.module';
import { AgentWorkerService } from './agent/agent-worker.service';

/** 只运行项目编码队列，不启动定时任务、导入、备份等通用后台作业。 */
@Module({
  imports: [
    ConfigModule.forRoot(environmentConfigOptions),
    PrismaModule,
    CryptoModule,
    ProjectAccessModule,
    WorkspaceModule,
    GitModule,
    AgentModule,
  ],
  providers: [AgentWorkerService],
})
export class AgentWorkerAppModule {}
