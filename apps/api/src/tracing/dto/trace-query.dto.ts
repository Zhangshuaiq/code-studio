import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class TraceSearchQueryDto {
  @IsUUID() projectId!: string;
  @IsOptional() @Matches(/^(?:|[a-fA-F0-9]{16,32})$/) traceId?: string;
  @IsOptional() @IsString() @MaxLength(200) service?: string;
  @IsOptional() @IsString() @MaxLength(100) language?: string;
  @IsOptional() @IsString() @MaxLength(100) environment?: string;
  @IsOptional() @IsIn(['', 'error']) status?: string;
  @IsOptional() @Type(() => Number) @Min(0) @Max(86_400_000) minDurationMs?: number;
  @IsOptional() @IsString() @MaxLength(100) from?: string;
  @IsOptional() @IsString() @MaxLength(100) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 30;
}

export class TraceDetailQueryDto {
  @IsUUID() projectId!: string;
}
