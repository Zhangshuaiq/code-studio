import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { LanguageRequestDto } from './dto/language-request.dto';
import { WorkspaceLanguageService } from './workspace-language.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.PROJECT_READ)
@Controller('sessions/:sessionId/language')
export class WorkspaceLanguageController {
  constructor(private readonly language: WorkspaceLanguageService) {}
  @Get('source')
  source(@CurrentUser() user: AuthUser, @Param('sessionId') sessionId: string, @Query('path') path: string) {
    return this.language.source(user.id, sessionId, path);
  }
  @Post(':operation')
  execute(@CurrentUser() user: AuthUser, @Param('sessionId') sessionId: string, @Param('operation') operation: string, @Body() body: LanguageRequestDto) {
    return this.language.execute(user.id, sessionId, operation, body);
  }
}
