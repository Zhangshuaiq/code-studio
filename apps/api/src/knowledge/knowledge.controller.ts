import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { Audit } from "../audit/audit.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  CreateDocumentDto,
  CreateFolderDto,
  SaveDocumentDto,
  UpdateDocumentDto,
  UpdateFolderDto,
} from "./dto/knowledge.dto";
import { KnowledgeService } from "./knowledge.service";
@Controller("knowledge")
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}
  @Get("teams") teams(@CurrentUser() user: AuthUser) {
    return this.knowledge.teams(user.id);
  }
  @Get("teams/:teamId/tree") tree(
    @CurrentUser() user: AuthUser,
    @Param("teamId") teamId: string,
  ) {
    return this.knowledge.tree(user.id, teamId);
  }
  @Get("search")
  search(@CurrentUser() user: AuthUser, @Query("q") query = "") {
    return this.knowledge.search(user.id, query);
  }
  @Post("folders") @Audit("knowledge.folder.create", "knowledge-folder") folder(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateFolderDto,
  ) {
    return this.knowledge.createFolder(user.id, body);
  }
  @Patch("folders/:id")
  @Audit("knowledge.folder.update", "knowledge-folder")
  updateFolder(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: UpdateFolderDto,
  ) {
    return this.knowledge.updateFolder(user.id, id, body);
  }
  @Delete("folders/:id")
  @Audit("knowledge.folder.delete", "knowledge-folder")
  deleteFolder(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.knowledge.deleteFolder(user.id, id);
  }
  @Post("documents")
  @Audit("knowledge.document.create", "knowledge-document")
  create(@CurrentUser() user: AuthUser, @Body() body: CreateDocumentDto) {
    return this.knowledge.createDocument(user.id, body);
  }
  @Post("requirements/:requirementId/document")
  @Audit("knowledge.requirement-document.resolve", "knowledge-document")
  requirementDocument(
    @CurrentUser() user: AuthUser,
    @Param("requirementId") requirementId: string,
  ) {
    return this.knowledge.resolveRequirementDocument(user.id, requirementId);
  }
  @Get("documents/:id") detail(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
  ) {
    return this.knowledge.detail(user.id, id);
  }
  @Patch("documents/:id")
  @Audit("knowledge.document.update", "knowledge-document")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: UpdateDocumentDto,
  ) {
    return this.knowledge.update(user.id, id, body);
  }
  @Delete("documents/:id")
  @Audit("knowledge.document.delete", "knowledge-document")
  deleteDocument(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.knowledge.deleteDocument(user.id, id);
  }
  @Put("documents/:id/content")
  @Audit("knowledge.document.save", "knowledge-document")
  save(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: SaveDocumentDto,
  ) {
    return this.knowledge.save(user.id, id, body);
  }
  @Get("documents/:id/revisions") revisions(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
  ) {
    return this.knowledge.revisions(user.id, id);
  }
}
