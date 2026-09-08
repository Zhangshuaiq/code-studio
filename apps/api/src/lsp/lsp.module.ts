import { Module } from '@nestjs/common';
import { LspController } from './lsp.controller';
import { LspSessionService } from './lsp-session.service';

@Module({
  controllers: [LspController],
  providers: [LspSessionService],
  exports: [LspSessionService],
})
export class LspModule {}
