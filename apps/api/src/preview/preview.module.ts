import { Module } from '@nestjs/common';
import { PreviewService } from './preview.service';
import { PreviewController } from './preview.controller';
import { SandboxModule } from '../sandbox/sandbox.module';
import { K8sModule } from '../k8s/k8s.module';
import { K8sPreviewService } from './k8s-preview.service';
import { PreviewBuildAdminController } from './preview-build-admin.controller';
import { PreviewSourceController } from './preview-source.controller';
import { PreviewSourceSnapshotService } from './preview-source-snapshot.service';
import { PreviewRoutingController } from './preview-routing.controller';
import { PreviewRoutingService } from './preview-routing.service';

@Module({
  imports: [SandboxModule, K8sModule],
  controllers: [PreviewController, PreviewBuildAdminController, PreviewSourceController, PreviewRoutingController],
  providers: [PreviewService, K8sPreviewService, PreviewSourceSnapshotService, PreviewRoutingService],
  exports: [PreviewService],
})
export class PreviewModule {}
