import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateModelConfigDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label!: string;

  @IsOptional()
  @IsIn(['openai-compatible'])
  provider?: string;

  @IsOptional()
  @IsIn(['simple', 'aider'])
  engine?: string;

  @IsString()
  baseUrl!: string;

  @IsString()
  model!: string;

  @IsString()
  @MinLength(1)
  apiKey!: string; // 明文进来，落库前加密；接口永不回传

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
