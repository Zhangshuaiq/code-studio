import { Injectable } from '@nestjs/common';
import { DeployService } from '../deploy/deploy.service';
import { PreviewService } from '../preview/preview.service';

@Injectable()
export class RuntimeStatusMcpFacade {
  constructor(
    private readonly preview: PreviewService,
    private readonly deploy: DeployService,
  ) {}

  previewStatus(userId: string, sessionId: string) {
    return this.preview.readStatus(userId, sessionId);
  }

  deploymentStatus(userId: string, sessionId: string) {
    return this.deploy.readStatus(userId, sessionId);
  }
}
