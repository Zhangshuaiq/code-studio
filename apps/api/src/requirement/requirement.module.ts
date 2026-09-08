import { Module } from '@nestjs/common';
import { RequirementController } from './requirement.controller';
import { RequirementService } from './requirement.service';
import { RequirementMcpFacade } from './requirement-mcp.facade';

@Module({
  controllers: [RequirementController],
  providers: [RequirementService, RequirementMcpFacade],
  exports: [RequirementService, RequirementMcpFacade],
})
export class RequirementModule {}
