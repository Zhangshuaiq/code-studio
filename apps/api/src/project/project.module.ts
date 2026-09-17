import { Module } from '@nestjs/common';
import { ProjectService } from './project.service';
import { ProjectController } from './project.controller';
import { GitModule } from '../git/git.module';
import { ProjectMcpFacade } from './project-mcp.facade';
import { DeployModule } from '../deploy/deploy.module';

@Module({
  imports: [GitModule, DeployModule],
  controllers: [ProjectController],
  providers: [ProjectService, ProjectMcpFacade],
  exports: [ProjectService, ProjectMcpFacade],
})
export class ProjectModule {}
