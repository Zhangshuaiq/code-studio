import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { Audit } from '../audit/audit.decorator';
import { GitSettingsService } from './git-settings.service';
import {
  SaveGitCredentialDto,
  UpdateGitIdentityDto,
} from './dto/git-settings.dto';

@UseGuards(JwtAuthGuard)
@Controller('git')
export class GitSettingsController {
  constructor(private readonly settings: GitSettingsService) {}

  @Get('settings')
  getSettings(@CurrentUser() user: AuthUser) {
    return this.settings.getSettings(user.id);
  }

  @Put('identity')
  @Audit('git.identity.update', 'git-identity')
  saveIdentity(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateGitIdentityDto,
  ) {
    return this.settings.saveIdentity(user.id, dto);
  }

  @Put('credentials')
  @Audit('git.credential.update', 'git-credential')
  saveCredential(
    @CurrentUser() user: AuthUser,
    @Body() dto: SaveGitCredentialDto,
  ) {
    return this.settings.saveCredential(user.id, dto);
  }

  @Delete('credentials/:id')
  @Audit('git.credential.delete', 'git-credential')
  removeCredential(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.settings.removeCredential(user.id, id);
  }
}
