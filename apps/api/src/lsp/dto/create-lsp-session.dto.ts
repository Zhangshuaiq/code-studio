import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export const LSP_LANGUAGES = [
  'typescript',
  'javascript',
  'java',
  'python',
  'go',
  'rust',
] as const;

export type LspLanguage = (typeof LSP_LANGUAGES)[number];

export class CreateLspSessionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @IsIn(LSP_LANGUAGES)
  language!: LspLanguage;
}
