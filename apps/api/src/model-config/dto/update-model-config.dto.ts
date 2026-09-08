import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateModelConfigDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label?: string;

  @IsOptional()
  @IsIn(['simple', 'aider'])
  engine?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  apiKey?: string; // 传了才更新 key（重新加密）；不传保持原样

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
