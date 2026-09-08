import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
export class NamespaceDto {
  @IsString() @MaxLength(63)
  @Matches(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/) name!: string;
}
export class ScaleDeploymentDto {
  @IsInt() @Min(0) @Max(1000) replicas!: number;
}
