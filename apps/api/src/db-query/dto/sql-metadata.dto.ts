import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
export class SqlMetadataDto {
  @IsIn(['databases', 'tables', 'columns']) action!: 'databases' | 'tables' | 'columns';
  @IsOptional() @IsString() @MaxLength(128) database?: string;
  @IsOptional() @IsString() @MaxLength(128) table?: string;
}
