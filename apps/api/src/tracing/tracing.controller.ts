import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { TracingService } from './tracing.service';
import { TraceDetailQueryDto, TraceSearchQueryDto } from './dto/trace-query.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';

@Controller('tracing')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.BUSINESS_LOG_READ)
export class TracingController {
  constructor(private readonly service: TracingService) {}
  @Get('health') health() { return this.service.health(); }
  @Get('traces') search(@CurrentUser() user: AuthUser, @Query() query: TraceSearchQueryDto) { return this.service.search(user.id, query); }
  @Get('traces/:traceId') trace(@CurrentUser() user: AuthUser, @Param('traceId') traceId: string, @Query() query: TraceDetailQueryDto) { return this.service.trace(user.id, query.projectId, traceId); }
}
