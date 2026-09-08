import { IsOptional, IsString, MaxLength } from 'class-validator';

export class StartPreviewDto {
  @IsOptional() @IsString() @MaxLength(64) requirementId?: string;
}
