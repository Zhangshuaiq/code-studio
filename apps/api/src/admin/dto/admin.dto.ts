import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PageQueryDto } from '../../common/dto/page-query.dto';

export class CreateAdminUserDto {
  @IsString() @MinLength(3) @MaxLength(32) @Matches(/^[A-Za-z0-9_-]+$/) username!: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(100) displayName?: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) roleIds?: string[];
}

export class UpdateAdminUserDto {
  @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
  @IsOptional() @IsString() @MaxLength(100) displayName?: string | null;
  @IsOptional() @IsIn(['active', 'disabled']) status?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) roleIds?: string[];
}

export class ResetPasswordDto {
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
}

export class CreateRoleDto {
  @IsString() @Matches(/^[a-z][a-z0-9_-]{1,63}$/) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) permissions!: string[];
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) permissions?: string[];
}

export class ProjectCleanupListQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(['deleting', 'deleting_cleanup', 'deletion_failed'])
  status?: string;
}

export class AcknowledgeProjectCleanupDto {
  @IsString() @MinLength(1) @MaxLength(2000) note!: string;
}

export class ForceProjectCleanupDto {
  @IsString() @MinLength(1) @MaxLength(200) projectName!: string;
  @IsString() @MinLength(10) @MaxLength(2000) note!: string;
}
