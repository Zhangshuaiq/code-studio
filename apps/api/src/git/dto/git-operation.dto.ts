import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
export class BranchNameDto {
  @IsString() @MinLength(1) @MaxLength(200)
  @Matches(/^(?!-)(?!.*\.\.)(?!.*[~^:?*\[\\\s])[^/]+(?:\/[^/]+)*$/)
  name!: string;
}
export class PushDto {
  @IsOptional() @IsBoolean() force?: boolean;
}
