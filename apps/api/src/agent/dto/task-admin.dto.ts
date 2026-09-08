import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PageQueryDto } from '../../common/dto/page-query.dto';
export class TaskPriorityDto {
  @IsInt() @Min(1) @Max(10) priority!: number;
}

export class GenerationTaskListQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out']) status?: string;
  @IsOptional() @IsString() @MaxLength(64) teamId?: string;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
}
