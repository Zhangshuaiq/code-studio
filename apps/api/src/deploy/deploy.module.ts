import { Module } from "@nestjs/common";
import { DeployService } from "./deploy.service";
import { DeployController } from "./deploy.controller";
import { DeployTargetService } from "./deploy-target.service";
import { DeployTargetController } from "./deploy-target.controller";
import { RegistryService } from "./registry.service";
import { RegistryController } from "./registry.controller";
import { SandboxModule } from "../sandbox/sandbox.module";
import { DeploymentCenterService } from "./deployment-center.service";
import { DeploymentCenterController } from "./deployment-center.controller";
import { DatasourceModule } from "../datasource/datasource.module";

@Module({
  imports: [SandboxModule, DatasourceModule],
  controllers: [
    DeployController,
    DeployTargetController,
    RegistryController,
    DeploymentCenterController,
  ],
  providers: [
    DeployService,
    DeployTargetService,
    RegistryService,
    DeploymentCenterService,
  ],
  exports: [DeployTargetService, DeployService],
})
export class DeployModule {}
