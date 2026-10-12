import { IsOptional, IsString, MaxLength } from 'class-validator';
export class GitBlameDto {
  @IsString()
  @MaxLength(1024)
  path!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024 * 1024)
  content?: string;
}
