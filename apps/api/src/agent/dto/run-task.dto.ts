import { IsString, IsUUID, MinLength, MaxLength } from 'class-validator';

export class RunTaskDto {
  @IsUUID()
  sessionId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  prompt!: string;
}
