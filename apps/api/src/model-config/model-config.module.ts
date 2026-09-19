import { Module } from '@nestjs/common';
import { ModelConfigService } from './model-config.service';
import { ModelConfigController } from './model-config.controller';
import { AgentRuntimeStateService } from '../agent/agent-runtime-state.service';

@Module({
  controllers: [ModelConfigController],
  providers: [ModelConfigService, AgentRuntimeStateService],
  exports: [ModelConfigService],
})
export class ModelConfigModule {}
