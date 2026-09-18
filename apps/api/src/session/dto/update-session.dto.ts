import { IsOptional, IsString, IsUUID, MaxLength, Matches } from 'class-validator';

export class UpdateSessionDto {
  // 切换本会话使用的模型配置；传 null 表示回退到用户默认
  @IsOptional()
  @IsUUID()
  modelConfigId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
  modelName?: string | null;
}
