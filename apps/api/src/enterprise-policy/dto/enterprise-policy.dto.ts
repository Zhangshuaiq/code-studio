import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

export class CreateOrganizationDto {
  @IsString() @Length(2, 120) name!: string;
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{1,62}$/) slug!: string;
  @IsOptional() @IsInt() @Min(1) @Max(100000) seatLimit?: number;
}
export class AddOrganizationMemberDto {
  @IsUUID() userId!: string;
  @IsOptional() @IsIn(['owner', 'admin', 'member']) role?: string;
}
export class CreateOrganizationInvitationDto {
  @IsEmail() @Length(3, 320) email!: string;
  @IsOptional() @IsIn(['admin', 'member']) role?: string;
  @IsOptional() @IsInt() @Min(1) @Max(30) expiresInDays?: number;
}
export class AcceptOrganizationInvitationDto {
  @IsString() @Length(40, 200) token!: string;
}
export class OrganizationDomainDto {
  @IsString() @Length(4, 253) domain!: string;
}
export class UpdateEnterprisePolicyDto {
  @IsBoolean() terminalEnabled!: boolean;
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) allowedModelEngines!: string[];
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) allowedConnectorTypes!: string[];
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) allowedGitHosts!: string[];
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) allowedNetworkHosts!: string[];
  @IsString() @Matches(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) minimumClientVersion!: string;
  @IsInt() @Min(0) @Max(90) offlineDays!: number;
}
