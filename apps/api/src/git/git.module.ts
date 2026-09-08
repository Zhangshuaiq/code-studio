import { Global, Module } from '@nestjs/common';
import { GitService } from './git.service';
import { GitController } from './git.controller';
import { FilesModule } from '../files/files.module';
import { PreviewModule } from '../preview/preview.module';
import { GitSettingsController } from './git-settings.controller';
import { GitSettingsService } from './git-settings.service';

@Global()
@Module({
  imports: [FilesModule, PreviewModule],
  controllers: [GitController, GitSettingsController],
  providers: [GitService, GitSettingsService],
  exports: [GitService, GitSettingsService],
})
export class GitModule {}
