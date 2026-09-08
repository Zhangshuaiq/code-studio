import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
export class ProxyRequestDto {
  @IsIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) method!: string;
  @IsString() @MaxLength(2048) @Matches(/^\/(?!\/)/) path!: string;
  @IsOptional() @IsObject() headers?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(1048576) body?: string;
}
