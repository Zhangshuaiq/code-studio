import { IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../common/dto/page-query.dto';

export const MCP_APPROVAL_STATUSES = [
  'requested', 'approved', 'rejected', 'cancelled', 'expired', 'revoked',
  'consuming', 'consumed', 'execution_failed',
] as const;

export class McpApprovalQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(MCP_APPROVAL_STATUSES)
  status?: string;
}
