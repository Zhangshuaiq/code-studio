import { IsString, Matches, MaxLength } from 'class-validator';

export class ResolvePreviewRouteDto {
  @IsString() @MaxLength(32) @Matches(/^REQ-\d{8}-[A-F0-9]{6}$/i) requirementNo!: string;
  @IsString() @MaxLength(63) @Matches(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/) serviceKey!: string;
}
