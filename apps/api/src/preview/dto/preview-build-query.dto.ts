import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PageQueryDto } from '../../common/dto/page-query.dto';

export class PreviewBuildQueryDto extends PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  override pageSize = 50;
}

export class AdminPreviewBuildQueryDto extends PreviewBuildQueryDto {
  @IsOptional() @IsIn(['queued', 'building', 'succeeded', 'failed', 'cancelled'])
  status?: string;
}
