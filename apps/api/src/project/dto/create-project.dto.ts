import {
  IsString,
  IsOptional,
  IsIn,
  MinLength,
  MaxLength,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateProjectDto {
  @IsOptional()
  @IsIn(['blank', 'git'])
  source?: 'blank' | 'git';

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  // 项目运行时 id（对应 ProjectRuntime）。默认 react-vite（前端优先）。
  @IsOptional()
  @IsIn(['react-vite', 'java', 'node', 'python', 'react-native'])
  language?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^https:\/\/.+/i, { message: 'repositoryUrl 需为 https:// 开头的仓库地址' })
  @MaxLength(2048)
  repositoryUrl?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._\-/]{1,80}$/, { message: 'defaultBranch 格式不正确' })
  defaultBranch?: string;
}
