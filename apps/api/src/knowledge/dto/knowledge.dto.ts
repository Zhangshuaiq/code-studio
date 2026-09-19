import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsArray,
  IsBoolean,
  IsIn,
  ValidateNested,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Type } from 'class-transformer';

export class CreateFolderDto {
  @IsUUID() teamId!: string;
  @IsOptional() @IsUUID() parentId?: string;
  @IsString() @MaxLength(120) name!: string;
}
export class UpdateFolderDto {
  @IsOptional() @IsUUID() parentId?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}
export class CreateDocumentDto {
  @IsUUID() teamId!: string;
  @IsOptional() @IsUUID() folderId?: string;
  @IsOptional() @IsUUID() requirementId?: string;
  @IsString() @MaxLength(200) title!: string;
}
export class UpdateDocumentDto {
  @IsOptional() @IsUUID() folderId?: string | null;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}
export class SaveDocumentDto {
  @IsInt() @Min(1) @Max(2147483647) baseVersion!: number;
  @IsString() @MaxLength(1048576) contentMarkdown!: string;
  @IsOptional() @IsObject() layoutJson?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(200) changeSummary?: string;
}

export class KnowledgeGrantDto {
  @IsIn(['team', 'user']) granteeKind!: 'team' | 'user';
  @IsUUID() granteeId!: string;
  @IsBoolean() canView!: boolean;
  @IsBoolean() canEdit!: boolean;
  @IsBoolean() canDelete!: boolean;
}

export class BaseAclDto {
  @IsIn(['default', 'custom']) mode!: 'default' | 'custom';
  @IsArray() @ValidateNested({ each: true }) @Type(() => KnowledgeGrantDto) grants!: KnowledgeGrantDto[];
}

export class DocumentAclDto {
  @IsIn(['inherit', 'custom']) mode!: 'inherit' | 'custom';
  @IsArray() @ValidateNested({ each: true }) @Type(() => KnowledgeGrantDto) grants!: KnowledgeGrantDto[];
}

export class DocumentAccessRequestDto {
  @IsIn(['view', 'edit', 'delete']) permission!: 'view' | 'edit' | 'delete';
  @IsOptional() @IsString() @MaxLength(500) message?: string;
}
