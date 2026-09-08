import { IsOptional, IsUUID } from 'class-validator';

export class UpdateSessionDto {
  // 切换本会话使用的模型配置；传 null 表示回退到用户默认
  @IsOptional()
  @IsUUID()
  modelConfigId?: string | null;
}
