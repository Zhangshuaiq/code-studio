import { Module } from '@nestjs/common';
import { McpApprovalController } from './mcp-approval.controller';
import { McpApprovalService } from './mcp-approval.service';

@Module({
  controllers: [McpApprovalController],
  providers: [McpApprovalService],
  exports: [McpApprovalService],
})
export class McpApprovalModule {}
