import { Module } from '@nestjs/common';
import { LspController } from './lsp.controller';
import { LspSessionService } from './lsp-session.service';
import { WorkspaceLanguageController } from './workspace-language.controller';
import { WorkspaceLanguageService } from './workspace-language.service';

@Module({
  controllers: [LspController, WorkspaceLanguageController],
  providers: [LspSessionService, WorkspaceLanguageService],
  exports: [LspSessionService, WorkspaceLanguageService],
})
export class LspModule {}
