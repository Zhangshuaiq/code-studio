import { IsBoolean, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../common/dto/page-query.dto';

export class SaveRuntimeBindingDto {
  @IsString() @MaxLength(64) projectId!: string;
  @IsString() @MaxLength(64) targetId!: string;
  @IsIn(['preview', 'deploy']) purpose!: string;
  @IsString() @Matches(/^[a-z0-9][a-z0-9_-]{0,31}$/) environment!: string;
  @IsOptional() @IsString() @MaxLength(120) branchPattern?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class RunDeploymentDto {
  @IsString() @MaxLength(64) projectId!: string;
  @IsString() @MaxLength(64) bindingId!: string;
  @IsString() @MaxLength(200) branch!: string;
}

export class DeploymentRecordQueryDto extends PageQueryDto {
  @IsOptional() @IsString() @MaxLength(64) projectId?: string;
}
