import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class RegistryConfigDto {
  @IsString() @MaxLength(512)
  @Matches(/^(?:https?:\/\/)?[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._/-]+)?$/)
  url!: string;
  @IsOptional() @IsString() @MaxLength(200) @Matches(/^[A-Za-z0-9._/-]+$/) project?: string;
  @IsString() @MinLength(1) @MaxLength(256) username!: string;
  @IsString() @MinLength(1) @MaxLength(4096) password!: string;
  @IsOptional() @IsBoolean() insecure?: boolean;
}

export class CreateRegistryDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @ValidateNested() @Type(() => RegistryConfigDto) config!: RegistryConfigDto;
}
