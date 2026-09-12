import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard'; import { CurrentUser } from '../auth/current-user.decorator'; import { Audit } from '../audit/audit.decorator'; import type { AuthUser } from '../auth/jwt.strategy';
import { CreateDocumentDto, CreateFolderDto, SaveDocumentDto, UpdateDocumentDto } from './dto/knowledge.dto'; import { KnowledgeService } from './knowledge.service';
@Controller('knowledge') @UseGuards(JwtAuthGuard)
export class KnowledgeController { constructor(private readonly knowledge: KnowledgeService) {}
  @Get('teams') teams(@CurrentUser() user: AuthUser) { return this.knowledge.teams(user.id); }
  @Get('teams/:teamId/tree') tree(@CurrentUser() user: AuthUser, @Param('teamId') teamId: string) { return this.knowledge.tree(user.id, teamId); }
  @Post('folders') @Audit('knowledge.folder.create', 'knowledge-folder') folder(@CurrentUser() user: AuthUser, @Body() body: CreateFolderDto) { return this.knowledge.createFolder(user.id, body); }
  @Post('documents') @Audit('knowledge.document.create', 'knowledge-document') create(@CurrentUser() user: AuthUser, @Body() body: CreateDocumentDto) { return this.knowledge.createDocument(user.id, body); }
  @Get('documents/:id') detail(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.knowledge.detail(user.id, id); }
  @Patch('documents/:id') @Audit('knowledge.document.update', 'knowledge-document') update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: UpdateDocumentDto) { return this.knowledge.update(user.id, id, body); }
  @Put('documents/:id/content') @Audit('knowledge.document.save', 'knowledge-document') save(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: SaveDocumentDto) { return this.knowledge.save(user.id, id, body); }
  @Get('documents/:id/revisions') revisions(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.knowledge.revisions(user.id, id); }
}
