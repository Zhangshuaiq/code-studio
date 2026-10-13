import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  IsInt,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PageQueryDto } from '../../common/dto/page-query.dto';

export class RedisBrowseDto {
  @IsIn(['scan', 'inspect', 'value']) action!: string;
  @IsOptional() @IsString() @Matches(/^\d{1,20}$/) cursor?: string;
  @IsOptional() @IsString() @MaxLength(1000) match?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) count?: number;
  @IsOptional() @IsString() @MaxLength(12000) key?: string;
  @IsOptional() @IsIn(['utf8', 'base64']) keyEncoding?: string;
  @IsOptional() @IsInt() @Min(0) @Max(536870912) offset?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000000) scanOffset?: number;
}

export class ExecuteQueryDto {
  @IsOptional() @ValidateNested() @Type(() => RedisBrowseDto) redisBrowse?: RedisBrowseDto;
  @IsOptional() @IsString() @MaxLength(1_000_000) sql?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @IsString({ each: true }) command?: string[];
  @IsOptional() @IsString() @MaxLength(128) database?: string;
  @IsOptional() @IsString() @MaxLength(128) collection?: string;
  @IsOptional() @IsIn(['find', 'findOne', 'countDocuments']) operation?: string;
  @IsOptional() @IsObject() query?: Record<string, unknown>;
}

export class ExportDataDto {
  @IsString() @MaxLength(128) @Matches(/^[A-Za-z_][A-Za-z0-9_$-]{0,127}$/) database!: string;
  @IsOptional() @IsIn(['csv', 'xlsx']) format?: string;
  @IsOptional() @IsIn(['table', 'query']) scope?: string;
  @IsOptional() @IsString() @MaxLength(128) @Matches(/^[A-Za-z_][A-Za-z0-9_$-]{0,127}$/) table?: string;
  @IsOptional() @IsString() @MaxLength(1_000_000) sql?: string;
}

export class ImportDataDto {
  @IsString() @MaxLength(128) @Matches(/^[A-Za-z_][A-Za-z0-9_$-]{0,127}$/) database!: string;
  @IsString() @MaxLength(128) @Matches(/^[A-Za-z_][A-Za-z0-9_$-]{0,127}$/) table!: string;
}

export class ReasonDto {
  @IsString() @MaxLength(2000) reason!: string;
}

export class TransferDto {
  @IsOptional() @IsIn(['migration', 'backup', 'native_backup']) kind?: string;
  @IsString() @MaxLength(64) sourceDatasourceId!: string;
  @IsOptional() @IsString() @MaxLength(64) targetDatasourceId?: string;
  @IsString() @MaxLength(128) @Matches(/^[A-Za-z_][A-Za-z0-9_$-]{0,127}$/) sourceDatabase!: string;
  @IsOptional() @IsString() @MaxLength(128) @Matches(/^[A-Za-z_][A-Za-z0-9_$-]{0,127}$/) targetDatabase?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @IsString({ each: true }) @Matches(/^[A-Za-z_][A-Za-z0-9_$-]{0,127}$/, { each: true }) tables!: string[];
  @IsOptional() @IsIn(['fail', 'append', 'replace']) conflictStrategy?: string;
}

export class RestoreDto {
  @IsString() @MaxLength(64) targetDatasourceId!: string;
  @IsString() @MaxLength(128) @Matches(/^[A-Za-z_][A-Za-z0-9_$-]{0,127}$/) targetDatabase!: string;
}

export class RetryTransferDto {
  @IsOptional() @IsIn(['fail', 'append', 'replace']) conflictStrategy?: string;
}

export class ApprovalListQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(['pending', 'approved', 'rejected', 'executed', 'failed'])
  status?: string;
}
