import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class KafkaMessageQueryDto {
  @Type(() => Number) @IsInt() @Min(0) @IsOptional() partition?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit = 20;
  @Transform(({ value }) => value === undefined ? true : value === true || value === 'true') @IsBoolean() @IsOptional() fromBeginning = true;
}

export class KafkaProduceDto {
  @IsString() @MaxLength(1_048_576) value!: string;
  @IsString() @MaxLength(8_192) @IsOptional() key?: string;
  @Type(() => Number) @IsInt() @Min(0) @IsOptional() partition?: number;
}

export class KafkaCreateTopicDto {
  @IsString() @MaxLength(249) topic!: string;
  @IsInt() @Min(1) @Max(10_000) partitions!: number;
  @IsInt() @Min(1) @Max(100) replicationFactor!: number;
  @IsInt() @Min(60_000) @IsOptional() retentionMs?: number;
  @IsInt() @Min(-1) @IsOptional() retentionBytes?: number;
  @IsInt() @Min(1_048_576) @IsOptional() maxMessageBytes?: number;
  @IsIn(['delete', 'compact', 'delete,compact']) @IsOptional() cleanupPolicy?: string;
  @IsInt() @Min(1) @IsOptional() minInsyncReplicas?: number;
  @IsIn(['producer', 'uncompressed', 'gzip', 'snappy', 'lz4', 'zstd']) @IsOptional() compressionType?: string;
}

export class KafkaIncreasePartitionsDto { @IsInt() @Min(1) @Max(10_000) count!: number; }
export class KafkaTopicConfigDto {
  @IsInt() @Min(60_000) @IsOptional() retentionMs?: number;
  @IsInt() @Min(-1) @IsOptional() retentionBytes?: number;
  @IsInt() @Min(1_048_576) @IsOptional() maxMessageBytes?: number;
  @IsIn(['delete', 'compact', 'delete,compact']) @IsOptional() cleanupPolicy?: string;
  @IsInt() @Min(1) @IsOptional() segmentMs?: number;
  @IsInt() @Min(1_048_576) @IsOptional() segmentBytes?: number;
  @IsInt() @Min(1) @IsOptional() minInsyncReplicas?: number;
  @IsIn(['producer', 'uncompressed', 'gzip', 'snappy', 'lz4', 'zstd']) @IsOptional() compressionType?: string;
  @IsInt() @Min(0) @IsOptional() deleteRetentionMs?: number;
  @IsInt() @Min(1) @IsOptional() maxCompactionLagMs?: number;
  @IsInt() @Min(0) @IsOptional() minCompactionLagMs?: number;
  @IsIn(['CreateTime', 'LogAppendTime']) @IsOptional() messageTimestampType?: string;
}
export class KafkaConfirmationDto { @IsString() @MaxLength(255) confirmation!: string; }
export class KafkaDeleteRecordsDto extends KafkaConfirmationDto { @IsInt() @Min(0) partition!: number; @IsString() @MaxLength(32) offset!: string; }
export class KafkaGroupOffsetDto { @IsInt() @Min(0) partition!: number; @IsString() @MaxLength(32) offset!: string; }
export class KafkaSetOffsetsDto extends KafkaConfirmationDto {
  @IsString() @MaxLength(249) topic!: string;
  @IsArray() @ValidateNested({ each:true }) @Type(() => KafkaGroupOffsetDto) offsets!: KafkaGroupOffsetDto[];
}
