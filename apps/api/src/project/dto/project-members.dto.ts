import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ProjectMembersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @IsString({ each: true }) @MaxLength(64, { each: true }) userIds!: string[];
  @IsOptional() @IsIn(['maintainer', 'developer', 'viewer']) role?: string;
}

export class ProjectMemberRoleDto {
  @IsIn(['maintainer', 'developer', 'viewer']) role!: string;
}
