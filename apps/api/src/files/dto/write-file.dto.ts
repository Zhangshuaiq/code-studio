import { IsString, IsOptional, Matches, MaxLength } from 'class-validator';

export class WriteFileDto {
  @IsString()
  @MaxLength(1_024)
  path!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  expectedVersion?: string;
}
