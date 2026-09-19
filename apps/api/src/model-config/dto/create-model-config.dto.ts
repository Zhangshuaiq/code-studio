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
  @IsIn(['simple', 'aider', 'codex', 'codex-cli', 'claude-code', 'deepseek-agent', 'glm-agent'])
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
  apiKey?: string; // 仅 API 模式需要；接口永不回传

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
