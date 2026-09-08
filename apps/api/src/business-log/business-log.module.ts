import { Module } from "@nestjs/common";
import {
  BusinessLogController,
  BusinessLogIngestController,
} from "./business-log.controller";
import { BusinessLogService } from "./business-log.service";
import { OpenSearchService } from "./opensearch.service";

@Module({
  controllers: [BusinessLogIngestController, BusinessLogController],
  providers: [BusinessLogService, OpenSearchService],
  exports: [BusinessLogService],
})
export class BusinessLogModule {}
