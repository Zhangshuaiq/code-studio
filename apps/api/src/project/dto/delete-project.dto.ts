import { IsBoolean, IsOptional } from 'class-validator';

export class DeleteProjectDto {
  @IsOptional()
  @IsBoolean()
  cleanupDeployment?: boolean;
}
