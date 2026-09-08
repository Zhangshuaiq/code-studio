import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class ServiceMetricsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(1440)
  minutes = 60;
}

export class KubernetesNamespacesQueryDto {
  @IsString() @MaxLength(64) targetId!: string;
}

export class KubernetesPodMetricsQueryDto extends KubernetesNamespacesQueryDto {
  @IsOptional() @Matches(/^[a-zA-Z0-9_.:-]{1,253}$/) namespace?: string;
  @IsOptional() @Matches(/^[a-zA-Z0-9_.:-]{1,253}$/) pod?: string;
  @IsOptional() @Matches(/^[a-zA-Z0-9_.:-]{1,253}$/) podPrefix?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(1440)
  minutes = 60;
}
