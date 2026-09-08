import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class SetRemoteDto {
  @IsString()
  @Matches(/^https:\/\/.+/i, { message: 'remoteUrl 需为 https:// 开头的仓库地址' })
  @MaxLength(2048)
  remoteUrl!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._\-/]{1,80}$/, { message: 'branch 格式不正确' })
  branch?: string;
}
