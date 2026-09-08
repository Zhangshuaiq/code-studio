import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsBoolean,
  ValidateNested,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PageQueryDto } from '../../common/dto/page-query.dto';

export class CreateTaskApplicationDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsString() @MaxLength(2048) baseUrl!: string;
  @IsOptional() @IsString() @MinLength(16) @MaxLength(256) token?: string;
}

export class CreateScheduledTaskDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsString() @MaxLength(64) handlerId!: string;
  @IsOptional() @IsObject() parameters?: Record<string, unknown>;
  @IsOptional() @IsIn(['immediate', 'once', 'cron']) scheduleType?: string;
  @IsOptional() @IsString() @MaxLength(200) cronExpression?: string;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  @IsOptional() @IsString() @MaxLength(100) executeAt?: string;
  @IsOptional() @IsString() @MaxLength(100) expiresAt?: string;
  @IsOptional() @IsIn(['forbid', 'allow']) concurrencyPolicy?: string;
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeoutSeconds?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5) maxRetries?: number;
}

export class RejectScheduledTaskDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

export class ChangeScheduledTaskStatusDto {
  @IsIn(['enabled', 'paused']) status!: string;
}

export class JavaHandlerRegistrationDto {
  @IsString() @MinLength(3) @MaxLength(128) methodName!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsObject() parameterSchema?: Record<string, unknown>;
  @IsOptional() @IsIn(['low', 'medium', 'high']) riskLevel?: string;
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeoutSeconds?: number;
  @IsOptional() @IsBoolean() allowConcurrent?: boolean;
  @IsOptional() @IsBoolean() idempotent?: boolean;
}

export class RegisterJavaHandlersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => JavaHandlerRegistrationDto)
  handlers!: JavaHandlerRegistrationDto[];
  @IsOptional() @IsString() @MaxLength(100) version?: string;
  @IsOptional() @IsString() @MaxLength(2048) baseUrl?: string;
}

export class ScheduledTaskListQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(['pending_approval', 'enabled', 'paused', 'completed', 'rejected', 'expired'])
  status?: string;
}
