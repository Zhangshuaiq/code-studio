import { Global, Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { DistributedWorkspaceLockService } from './distributed-workspace-lock.service';
import { WorkspaceLockInterceptor } from './workspace-lock.interceptor';

@Global()
@Module({
  providers: [WorkspaceService, DistributedWorkspaceLockService, WorkspaceLockInterceptor],
  exports: [WorkspaceService, DistributedWorkspaceLockService, WorkspaceLockInterceptor],
})
export class WorkspaceModule {}
