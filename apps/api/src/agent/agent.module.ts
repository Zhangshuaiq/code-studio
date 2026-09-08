import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { AgentCredentialResolver } from './credential-resolver';
import { ClaudeAgentProvider } from './providers/claude-agent.provider';
import { SimpleLlmProvider } from './providers/simple-llm.provider';
import { AiderProvider } from './providers/aider.provider';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PreviewModule } from '../preview/preview.module';
import { ModelConfigModule } from '../model-config/model-config.module';
import { AgentQueueService } from './agent-queue.service';
import { GenerationExecutorService } from './generation-executor.service';
import { GenerationSchedulerService } from './generation-scheduler.service';

@Module({
  imports: [SandboxModule, PreviewModule, ModelConfigModule],
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentQueueService,
    GenerationExecutorService,
    GenerationSchedulerService,
    AgentCredentialResolver,
    ClaudeAgentProvider,
    SimpleLlmProvider,
    AiderProvider,
  ],
  exports: [
    AgentService,
    AgentQueueService,
    GenerationExecutorService,
    GenerationSchedulerService,
  ],
})
export class AgentModule {}
