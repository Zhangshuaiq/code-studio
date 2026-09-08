import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { PERMISSIONS } from "../auth/permissions";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthUser } from "../auth/jwt.strategy";
import { Audit } from "../audit/audit.decorator";
import { BusinessLogService } from "./business-log.service";
import { PageQueryDto } from "../common/dto/page-query.dto";
import {
  CreateBusinessLogSourceDto,
  CreateMonitoringAlertRuleDto,
  ApplicationMetricsDto,
  IngestBusinessLogsDto,
  SearchBusinessLogsDto,
  UpdateBusinessLogPolicyDto,
  UpdateBusinessLogSourceDto,
  UpdateMonitoringAlertRuleDto,
  UpdateAlertNotificationDto,
} from "./dto/business-log.dto";

@Controller("business-logs")
export class BusinessLogIngestController {
  constructor(private readonly logs: BusinessLogService) {}

  @Post("ingest")
  ingest(
    @Headers("authorization") authorization: string | undefined,
    @Headers("x-log-source-token") sourceToken: string | undefined,
    @Body() dto: IngestBusinessLogsDto,
  ) {
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    return this.logs.ingest(sourceToken || bearer, dto);
  }
}

@Controller("business-logs")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.BUSINESS_LOG_READ)
export class BusinessLogController {
  constructor(private readonly logs: BusinessLogService) {}

  @Post("search")
  search(@CurrentUser() user: AuthUser, @Body() dto: SearchBusinessLogsDto) {
    return this.logs.search(user, dto);
  }

  @Post("metrics")
  metrics(@CurrentUser() user: AuthUser, @Body() dto: ApplicationMetricsDto) {
    return this.logs.applicationMetrics(user, dto);
  }

  @Post("platform-metrics")
  platformMetrics(
    @CurrentUser() user: AuthUser,
    @Body() dto: ApplicationMetricsDto,
  ) {
    return this.logs.platformMetrics(user, dto);
  }

  @Get("alert-rules/:projectId")
  alertRules(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string) {
    return this.logs.listAlertRules(user, projectId);
  }

  @Post("alert-rules")
  @Audit("monitoring.alert-rule.create", "monitoring-alert-rule")
  createAlertRule(@CurrentUser() user: AuthUser, @Body() dto: CreateMonitoringAlertRuleDto) {
    return this.logs.createAlertRule(user, dto);
  }

  @Patch("alert-rules/:id")
  @Audit("monitoring.alert-rule.update", "monitoring-alert-rule")
  updateAlertRule(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: UpdateMonitoringAlertRuleDto) {
    return this.logs.updateAlertRule(user, id, dto);
  }

  @Delete("alert-rules/:id")
  @Audit("monitoring.alert-rule.delete", "monitoring-alert-rule")
  deleteAlertRule(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.logs.deleteAlertRule(user, id);
  }

  @Get("alert-events/:projectId")
  alertEvents(@CurrentUser() user: AuthUser, @Param("projectId") projectId: string, @Query() query: PageQueryDto) {
    return this.logs.listAlertEvents(user, projectId, query);
  }

  @Get("alert-notification")
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  alertNotification() {
    return this.logs.getAlertNotificationConfig();
  }

  @Put("alert-notification")
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  @Audit("monitoring.alert-notification.update", "system-setting")
  updateAlertNotification(@CurrentUser() user: AuthUser, @Body() dto: UpdateAlertNotificationDto) {
    return this.logs.updateAlertNotificationConfig(user.id, dto);
  }

  @Post("alert-notification/test")
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  @Audit("monitoring.alert-notification.test", "system-setting")
  testAlertNotification() {
    return this.logs.testAlertNotification();
  }

  @Get("health")
  health() {
    return this.logs.getHealth();
  }

  @Get("policy")
  policy() {
    return this.logs.getPolicy();
  }

  @Put("policy")
  @RequirePermissions(PERMISSIONS.SYSTEM_SETTING_MANAGE)
  @Audit("business-log.policy.update", "system-setting")
  updatePolicy(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateBusinessLogPolicyDto,
  ) {
    return this.logs.updatePolicy(user.id, dto);
  }

  @Get("sources")
  @RequirePermissions(PERMISSIONS.BUSINESS_LOG_SOURCE_MANAGE)
  sources(@CurrentUser() user: AuthUser) {
    return this.logs.listSources(user);
  }

  @Post("sources")
  @RequirePermissions(PERMISSIONS.BUSINESS_LOG_SOURCE_MANAGE)
  @Audit("business-log.source.create", "business-log-source")
  createSource(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateBusinessLogSourceDto,
  ) {
    return this.logs.createSource(user, dto);
  }

  @Patch("sources/:id")
  @RequirePermissions(PERMISSIONS.BUSINESS_LOG_SOURCE_MANAGE)
  @Audit("business-log.source.update", "business-log-source")
  updateSource(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() dto: UpdateBusinessLogSourceDto,
  ) {
    return this.logs.updateSource(user, id, dto);
  }

  @Post("sources/:id/rotate-token")
  @RequirePermissions(PERMISSIONS.BUSINESS_LOG_SOURCE_MANAGE)
  @Audit("business-log.source.rotate-token", "business-log-source")
  rotateSourceToken(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.logs.rotateSourceToken(user, id);
  }

  @Delete("sources/:id")
  @RequirePermissions(PERMISSIONS.BUSINESS_LOG_SOURCE_MANAGE)
  @Audit("business-log.source.delete", "business-log-source")
  deleteSource(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.logs.deleteSource(user, id);
  }
}
