import { IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';

export class ActivateLicenseDto {
  @IsString() @Length(16, 256) deviceId!: string;
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(50) platform?: string;
  @IsOptional() @IsString() @MaxLength(50) appVersion?: string;
}

export class AssignSubscriptionDto {
  @IsUUID() userId!: string;
  @IsIn(['personal-pro', 'team', 'enterprise']) edition!: string;
  @IsDateString() expiresAt!: string;
  @IsOptional() @IsIn(['active', 'suspended', 'cancelled']) status?: string;
  @IsOptional() @IsInt() @Min(0) @Max(90) graceDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) maxDevices?: number;
}

export class RedeemLicenseDto { @IsString() @Length(12, 128) code!: string; }

export class CreateRedeemCodeDto {
  @IsIn(['personal-pro', 'team', 'enterprise']) edition!: string;
  @IsInt() @Min(1) @Max(3650) durationDays!: number;
  @IsOptional() @IsInt() @Min(0) @Max(90) graceDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) maxDevices?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10000) maxRedemptions?: number;
  @IsOptional() @IsDateString() expiresAt?: string;
}

export class IssueOfflineLicenseDto {
  @IsUUID() userId!: string;
  @IsObject() challenge!: object;
}
