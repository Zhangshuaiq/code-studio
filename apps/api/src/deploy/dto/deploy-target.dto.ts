import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateDeployTargetDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsIn(['local-docker', 'docker-tcp', 'docker-ssh', 'k8s', 'server-artifact']) kind!: string;
  @IsObject() config!: Record<string, unknown>;
  @IsOptional() @IsIn(['personal', 'team', 'platform']) scope?: string;
  @IsOptional() @IsString() @MaxLength(64) teamId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['preview', 'deploy'], { each: true }) purposes?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) labels?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsNumber() @Min(1) @Max(500) maxPreviewInstances?: number;
  @IsOptional() @IsNumber() @Min(0.01) @Max(10000) capacityCpu?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(1073741824) capacityMemoryMb?: number;
}

export class UpdateDeployTargetDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsIn(['personal', 'team', 'platform']) scope?: string;
  @IsOptional() @IsString() @MaxLength(64) teamId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['preview', 'deploy'], { each: true }) purposes?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) labels?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsNumber() @Min(1) @Max(500) maxPreviewInstances?: number;
  @IsOptional() @IsNumber() @Min(0.01) @Max(10000) capacityCpu?: number | null;
  @IsOptional() @IsNumber() @Min(1) @Max(1073741824) capacityMemoryMb?: number | null;
}
