import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser } from '../auth/jwt.strategy';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { Audit } from '../audit/audit.decorator';
import { McpApprovalQueryDto } from './dto/mcp-approval-query.dto';
import { ApproveMcpApprovalDto, RejectMcpApprovalDto } from './dto/mcp-approval-decision.dto';
import { McpApprovalService } from './mcp-approval.service';

@Controller('mcp-approvals')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class McpApprovalController {
  constructor(private readonly approvals: McpApprovalService) {}

  @Get('mine')
  mine(@CurrentUser() user: AuthUser, @Query() query: McpApprovalQueryDto) {
    return this.approvals.listMine(user.id, query);
  }

  @Get('mine/:id')
  getMine(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.approvals.getMine(user.id, id);
  }

  @Get('review/:id')
  @RequirePermissions(PERMISSIONS.MCP_APPROVAL_REVIEW)
  getForReview(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.approvals.getForReview(user, id);
  }

  @Get('review-pending')
  @RequirePermissions(PERMISSIONS.MCP_APPROVAL_REVIEW)
  pending(@CurrentUser() user: AuthUser, @Query() query: McpApprovalQueryDto) {
    return this.approvals.listForReview(user, query);
  }

  @Post('review/:id/approve')
  @RequirePermissions(PERMISSIONS.MCP_APPROVAL_REVIEW)
  @Audit('mcp.approval.approve', 'mcp-tool-approval')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: ApproveMcpApprovalDto) {
    return this.approvals.approve(user, id, body.reason);
  }

  @Post('review/:id/reject')
  @RequirePermissions(PERMISSIONS.MCP_APPROVAL_REVIEW)
  @Audit('mcp.approval.reject', 'mcp-tool-approval')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: RejectMcpApprovalDto) {
    return this.approvals.reject(user, id, body.reason);
  }

  @Post('mine/:id/cancel')
  @Audit('mcp.approval.cancel', 'mcp-tool-approval')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.approvals.cancel(user.id, id);
  }
}
