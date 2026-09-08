import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  pageSize = 100;
}

export function pageArgs(query: PageQueryDto) {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

export function pageResult<T>(items: T[], total: number, query: PageQueryDto) {
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    hasNext: query.page * query.pageSize < total,
    pages: Math.ceil(total / query.pageSize),
  };
}
