import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { PageQueryDto } from '../../common/dto/page-query.dto';

export class RequirementQueryDto extends PageQueryDto {
  @IsOptional() @IsString() @MaxLength(64) teamId?: string;
  @IsOptional() @IsIn(['draft', 'active', 'completed', 'cancelled', 'archived']) status?: string;
}

export class CreateRequirementDto {
  @IsString() @MaxLength(64) teamId!: string;
  @IsString() @MinLength(1) @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsOptional() @IsString() @MaxLength(64) ownerId?: string;
  @IsOptional() @IsDateString() plannedStartAt?: string;
  @IsOptional() @IsDateString() plannedEndAt?: string;
}

export class UpdateRequirementDto {
  @IsDateString() baseUpdatedAt!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsOptional() @IsString() @MaxLength(64) ownerId?: string;
  @IsOptional() @IsIn(['draft', 'active', 'completed', 'cancelled', 'archived']) status?: string;
  @IsOptional() @IsDateString() plannedStartAt?: string | null;
  @IsOptional() @IsDateString() plannedEndAt?: string | null;
}

export class SaveRequirementDocumentDto {
  @Type(() => Number) @IsInt() @Min(1) baseVersion!: number;
  @IsString() @MaxLength(1_048_576) contentMarkdown!: string;
  @IsOptional() @IsString() @MaxLength(200) changeSummary?: string;
}

export class UpdateRequirementStageDto {
  @IsOptional() @IsString() @MaxLength(64) ownerId?: string;
  @IsOptional() @IsString() @MaxLength(65_536) descriptionMarkdown?: string;
  @IsOptional() @IsIn(['pending', 'in_progress', 'completed', 'blocked', 'skipped']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) progress?: number;
  @IsOptional() @IsString() @MaxLength(2_000) blockedReason?: string;
  @IsOptional() @IsDateString() plannedStartAt?: string;
  @IsOptional() @IsDateString() plannedEndAt?: string;
  @IsOptional() @IsString() @MaxLength(2_000) transitionReason?: string;
}

export class AddRequirementProjectDto {
  @IsString() @MaxLength(64) projectId!: string;
  @IsString() @MaxLength(63) serviceKey!: string;
  @IsOptional() @IsString() @MaxLength(64) developerId?: string;
  @IsOptional() @IsBoolean() changeRequired?: boolean;
}

export class UpdateRequirementProjectDto {
  @IsOptional() @IsString() @MaxLength(64) developerId?: string;
  @IsOptional() @IsBoolean() changeRequired?: boolean;
}
