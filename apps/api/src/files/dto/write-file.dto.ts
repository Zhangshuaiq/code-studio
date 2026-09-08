import { IsString, MaxLength } from 'class-validator';

export class WriteFileDto {
  @IsString()
  @MaxLength(1_024)
  path!: string;

  @IsString()
  content!: string;
}
