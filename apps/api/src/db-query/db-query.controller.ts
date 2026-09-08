import { Controller, Post, Get, Body, Param, Query, UseGuards, UseInterceptors, UploadedFile, Res } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { DbQueryService } from './db-query.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { Audit } from '../audit/audit.decorator';
import { ApprovalListQueryDto, ExecuteQueryDto, ExportDataDto, ImportDataDto, ReasonDto, RestoreDto, RetryTransferDto, TransferDto } from './dto/db-query.dto';
import { PageQueryDto } from '../common/dto/page-query.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.PROJECT_READ)
@Controller('db-query')
export class DbQueryController {
  constructor(private readonly dbQueryService: DbQueryService) {}

  // 执行查询
  @Post(':datasourceId/execute')
  @Audit('datasource.query', 'datasource')
  async executeQuery(
    @Param('datasourceId') datasourceId: string,
    @CurrentUser() user: AuthUser,
    @Body() payload: ExecuteQueryDto,
  ) {
    return this.dbQueryService.executeQuery(datasourceId, user.id, payload);
  }

  @Post(':datasourceId/export')
  @Audit('datasource.export', 'datasource')
  async exportData(@Param('datasourceId') datasourceId: string, @CurrentUser() user: AuthUser, @Body() body: ExportDataDto, @Res() response: Response) {
    const exported = await this.dbQueryService.exportData(datasourceId, user.id, body);
    response.setHeader('Content-Type', exported.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
    response.setHeader('X-Exported-Rows', String(exported.rows));
    response.send(exported.buffer);
  }

  @Post(':datasourceId/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  @Audit('datasource.import.request', 'datasource')
  importData(@Param('datasourceId') datasourceId: string, @CurrentUser() user: AuthUser, @Body() body: ImportDataDto, @UploadedFile() file?: Express.Multer.File) {
    return this.dbQueryService.importData(datasourceId, user.id, body, file);
  }

  @Get('approvals/mine')
  async myApprovals(@CurrentUser() user: AuthUser, @Query() query: ApprovalListQueryDto) {
    return this.dbQueryService.listApprovals(user.id, false, query);
  }

  @Get('approvals/admin')
  async approvals(@CurrentUser() user: AuthUser, @Query() query: ApprovalListQueryDto) {
    return this.dbQueryService.listApprovals(user.id, true, query);
  }

  @Get('approvals/:id/analysis')
  analyzeApproval(@Param('id') id: string, @CurrentUser() user: AuthUser, @Query('refresh') refresh?: string) {
    return this.dbQueryService.analyzeApproval(id, user.id, refresh === 'true');
  }

  @Post('approvals/:id/approve')
  @Audit('datasource.approval.approve', 'database-approval')
  approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dbQueryService.approve(id, user.id);
  }

  @Post('approvals/:id/reject')
  @Audit('datasource.approval.reject', 'database-approval')
  reject(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() body: ReasonDto) {
    return this.dbQueryService.reject(id, user.id, body.reason);
  }

  @Post('transfers')
  @Audit('datasource.transfer.request', 'database-transfer')
  createTransfer(@CurrentUser() user: AuthUser, @Body() body: TransferDto) {
    return this.dbQueryService.createTransfer(user.id, body);
  }

  @Post('transfers/preflight')
  preflightTransfer(@CurrentUser() user: AuthUser, @Body() body: TransferDto) {
    return this.dbQueryService.preflightTransfer(user.id, body);
  }

  @Get('transfers/mine')
  transfers(@CurrentUser() user: AuthUser, @Query() query: PageQueryDto) {
    return this.dbQueryService.listTransfers(user.id, false, query);
  }

  @Get('transfers/admin')
  adminTransfers(@CurrentUser() user: AuthUser, @Query() query: PageQueryDto) {
    return this.dbQueryService.listTransfers(user.id, true, query);
  }

  @Get('transfers/:id/download')
  @Audit('datasource.backup.download', 'database-transfer')
  async downloadBackup(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() response: Response) {
    const file = await this.dbQueryService.readBackupFile(id, user.id, user.permissions.includes(PERMISSIONS.DATASOURCE_MANAGE));
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', String(file.size));
    response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    response.sendFile(file.path);
  }

  @Post('transfers/:id/restore')
  @Audit('datasource.restore.request', 'database-transfer')
  createRestore(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() body: RestoreDto) {
    return this.dbQueryService.createNativeRestore(id, user.id, body);
  }

  @Post('transfers/:id/approve')
  @Audit('datasource.transfer.approve', 'database-transfer')
  approveTransfer(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dbQueryService.approveTransfer(id, user.id);
  }

  @Post('transfers/:id/reject')
  @Audit('datasource.transfer.reject', 'database-transfer')
  rejectTransfer(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() body: ReasonDto) {
    return this.dbQueryService.rejectTransfer(id, user.id, body.reason);
  }

  @Post('transfers/:id/cancel')
  @Audit('datasource.transfer.cancel', 'database-transfer')
  cancelTransfer(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dbQueryService.cancelTransfer(id, user.id, user.permissions.includes(PERMISSIONS.DATASOURCE_MANAGE));
  }

  @Post('transfers/:id/retry')
  @Audit('datasource.transfer.retry', 'database-transfer')
  retryTransfer(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() body: RetryTransferDto) {
    return this.dbQueryService.retryTransfer(id, user.id, user.permissions.includes(PERMISSIONS.DATASOURCE_MANAGE), body.conflictStrategy);
  }

  // 获取数据库列表
  @Get(':datasourceId/databases')
  async listDatabases(
    @Param('datasourceId') datasourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.dbQueryService.listDatabases(datasourceId, user.id);
  }

  // 获取表列表
  @Get(':datasourceId/tables')
  async listTables(
    @Param('datasourceId') datasourceId: string,
    @CurrentUser() user: AuthUser,
    @Query('database') database?: string,
  ) {
    return this.dbQueryService.listTables(datasourceId, user.id, database);
  }

  // 获取表结构
  @Get(':datasourceId/tables/:tableName/describe')
  async describeTable(
    @Param('datasourceId') datasourceId: string,
    @Param('tableName') tableName: string,
    @CurrentUser() user: AuthUser,
    @Query('database') database?: string,
  ) {
    return this.dbQueryService.describeTable(datasourceId, user.id, tableName, database);
  }
}
