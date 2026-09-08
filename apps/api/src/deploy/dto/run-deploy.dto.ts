import { IsOptional, IsString, MaxLength } from 'class-validator';
export class RunDeployDto {
  @IsOptional() @IsString() @MaxLength(64) targetId?: string;
}
