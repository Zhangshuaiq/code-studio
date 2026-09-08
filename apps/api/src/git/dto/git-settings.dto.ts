import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateGitIdentityDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  authorName!: string;

  @IsEmail()
  @MaxLength(254)
  authorEmail!: string;
}

export class SaveGitCredentialDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  host!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  username?: string;

  // 更新时留空表示保留旧 token；首次配置必须提供。
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  token?: string;
}
