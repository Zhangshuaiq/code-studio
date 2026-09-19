import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { KnowledgeController } from "./knowledge.controller";
import { KnowledgeService } from "./knowledge.service";
import { KnowledgeAccessService } from './knowledge-access.service';
@Module({
  imports: [PrismaModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeAccessService],
  exports: [KnowledgeService, KnowledgeAccessService],
})
export class KnowledgeModule {}
