import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";

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
