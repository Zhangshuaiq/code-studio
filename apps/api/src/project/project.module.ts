import { Module } from '@nestjs/common';
import { ProjectService } from './project.service';
import { ProjectController } from './project.controller';
import { GitModule } from '../git/git.module';
import { ProjectMcpFacade } from './project-mcp.facade';

@Module({
  imports: [GitModule],
  controllers: [ProjectController],
  providers: [ProjectService, ProjectMcpFacade],
  exports: [ProjectService, ProjectMcpFacade],
})
export class ProjectModule {}
