import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { CreateLspSessionDto } from './dto/create-lsp-session.dto';
import { LspSessionService } from './lsp-session.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.PROJECT_READ)
@Controller('sessions/:sessionId/lsp')
export class LspController {
  constructor(private readonly sessions: LspSessionService) {}

  @Post('sessions')
  create(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Body() body: CreateLspSessionDto,
  ) {
    return this.sessions.create(user.id, sessionId, body.language);
  }

  @Get('sessions/:id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ) {
    return this.sessions.getForUser(user.id, sessionId, id);
  }

  @Delete('sessions/:id')
  close(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ) {
    return this.sessions.closeForUser(user.id, sessionId, id);
  }
}
