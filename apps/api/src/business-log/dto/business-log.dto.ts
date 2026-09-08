import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

export class BusinessLogEntryDto {
  @IsOptional()
  @IsISO8601()
  timestamp?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(65_536)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  level?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  logger?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  thread?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  traceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  spanId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(262_144)
  stackTrace?: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}

export class IngestBusinessLogsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => BusinessLogEntryDto)
  logs!: BusinessLogEntryDto[];
}

export class SearchBusinessLogsDto {
  @IsUUID()
  projectId!: string;

  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  environment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  serviceName?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  levels?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  query?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  traceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000)
  limit?: number;
}

export class ApplicationMetricsDto {
  @IsUUID()
  projectId!: string;

  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  environment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  serviceName?: string;
}

export class CreateMonitoringAlertRuleDto {
  @IsUUID()
  projectId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsIn(["success_rate", "error_rate", "p95_latency_ms"])
  metric!: string;

  @IsIn(["lt", "gt"])
  operator!: string;

  @Type(() => Number)
  @Min(0)
  threshold!: number;

  @IsInt()
  @Min(1)
  @Max(10080)
  windowMinutes!: number;

  @IsOptional() @IsString() @MaxLength(80)
  environment?: string;

  @IsOptional() @IsString() @MaxLength(160)
  serviceName?: string;

  @IsOptional() @IsInt() @Min(1) @Max(10080)
  cooldownMinutes?: number;
}

export class UpdateMonitoringAlertRuleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80)
  name?: string;

  @IsOptional() @IsIn(["success_rate", "error_rate", "p95_latency_ms"])
  metric?: string;

  @IsOptional() @IsIn(["lt", "gt"])
  operator?: string;

  @IsOptional() @Type(() => Number) @Min(0)
  threshold?: number;

  @IsOptional() @IsInt() @Min(1) @Max(10080)
  windowMinutes?: number;

  @IsOptional() @IsString() @MaxLength(80)
  environment?: string;

  @IsOptional() @IsString() @MaxLength(160)
  serviceName?: string;

  @IsOptional() @IsInt() @Min(1) @Max(10080)
  cooldownMinutes?: number;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

export class UpdateAlertNotificationDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: "Webhook URL 格式不正确" })
  @MaxLength(2_000)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  secret?: string;

  @IsOptional()
  @IsBoolean()
  clearSecret?: boolean;
}

export class CreateBusinessLogSourceDto {
  @IsUUID()
  projectId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  environment!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  serviceName!: string;

  @IsOptional()
  @IsIn(["json", "log4j"])
  format?: string;
}

export class UpdateBusinessLogSourceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  environment?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  serviceName?: string;

  @IsOptional()
  @IsIn(["json", "log4j"])
  format?: string;

  @IsOptional()
  @IsIn(["active", "disabled"])
  status?: string;
}

export class UpdateBusinessLogPolicyDto {
  @IsInt()
  @Min(1)
  @Max(3_650)
  retentionDays!: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1_440)
  defaultQueryRangeMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  maxQueryRangeHours?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10_000)
  maxResultLines?: number;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(120)
  queryTimeoutSeconds?: number;
}
