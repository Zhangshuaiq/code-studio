import { Type } from 'class-transformer';
import { IsArray, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, ArrayMaxSize, ValidateNested } from 'class-validator';

export class OpenLanguageDocumentDto {
  @IsString() @MaxLength(1024) path!: string;
  @IsString() @MaxLength(500_000) content!: string;
}

export class LanguageRequestDto {
  @IsOptional() @IsString() @MaxLength(1024) path?: string;
  @IsOptional() @IsString() @MaxLength(500_000) content?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000) line?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000) column?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000) endLine?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000) endColumn?: number;
  @IsOptional() @IsString() @MaxLength(200) newName?: string;
  @IsOptional() @IsString() @MaxLength(200) query?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) diagnostics?: Record<string, unknown>[];
  @IsOptional() @IsObject() item?: Record<string, unknown>;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => OpenLanguageDocumentDto)
  documents?: OpenLanguageDocumentDto[];
}
