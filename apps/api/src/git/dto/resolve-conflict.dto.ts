import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import type { ConflictResolution } from "../git.service";

export class ResolveConflictDto {
  @IsString()
  @MaxLength(1024)
  path!: string;

  @IsIn(["manual", "ours", "theirs", "both", "delete"])
  resolution!: ConflictResolution;

  @IsOptional()
  @IsString()
  @MaxLength(600_000)
  content?: string;
}
