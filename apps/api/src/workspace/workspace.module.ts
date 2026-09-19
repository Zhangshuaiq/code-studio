import { Global, Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { DistributedWorkspaceLockService } from './distributed-workspace-lock.service';
import { WorkspaceLockInterceptor } from './workspace-lock.interceptor';
import { WorkspaceStorageService } from './workspace-storage.service';
import { WorkspaceStorageConfigController } from './workspace-storage-config.controller';

@Global()
@Module({
  controllers: [WorkspaceStorageConfigController],
  providers: [WorkspaceStorageService, WorkspaceService, DistributedWorkspaceLockService, WorkspaceLockInterceptor],
  exports: [WorkspaceStorageService, WorkspaceService, DistributedWorkspaceLockService, WorkspaceLockInterceptor],
})
export class WorkspaceModule {}
