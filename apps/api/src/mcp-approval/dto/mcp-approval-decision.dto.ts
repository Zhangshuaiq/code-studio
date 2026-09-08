import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ApproveMcpApprovalDto {
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  reason?: string;
}

export class RejectMcpApprovalDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2_000)
  reason!: string;
}
