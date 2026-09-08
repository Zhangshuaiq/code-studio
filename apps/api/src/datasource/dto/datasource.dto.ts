import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQueryDto } from '../../common/dto/page-query.dto';

export interface DatasourceConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  db?: number;
  authSource?: string;
}

export class DatasourceConfigDto implements DatasourceConfig {
  @IsString() @MinLength(1) @MaxLength(253) @Matches(/^[A-Za-z0-9._:\[\]-]+$/) host!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(65535) port!: number;
  @IsOptional() @IsString() @MaxLength(256) username?: string;
  @IsOptional() @IsString() @MaxLength(4096) password?: string;
  @IsOptional() @IsString() @MaxLength(128) @Matches(/^[^\0\r\n/?#@]*$/) database?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(15) db?: number;
  @IsOptional() @IsString() @MaxLength(128) @Matches(/^[^\0\r\n/?#@]*$/) authSource?: string;
}

export class CreateDatasourceDto {
  @IsString() @MaxLength(64) teamId!: string;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsIn(['mysql', 'postgresql', 'redis', 'mongodb']) type!: 'mysql' | 'postgresql' | 'redis' | 'mongodb';
  @ValidateNested() @Type(() => DatasourceConfigDto) config!: DatasourceConfigDto;
}

export class UpdateDatasourceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @ValidateNested() @Type(() => DatasourceConfigDto) config?: DatasourceConfigDto;
}

export class DatasourceMembersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @IsString({ each: true }) @MaxLength(64, { each: true }) userIds!: string[];
}

export class DatasourceListQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(['relational', 'nosql'])
  category?: 'relational' | 'nosql';
}
