import { Module } from "@nestjs/common";
import {
  BusinessLogController,
  BusinessLogIngestController,
} from "./business-log.controller";
import { BusinessLogService } from "./business-log.service";
import { OpenSearchService } from "./opensearch.service";
import { MonitoringConfigModule } from "../monitoring-config/monitoring-config.module";

@Module({
  imports: [MonitoringConfigModule],
  controllers: [BusinessLogIngestController, BusinessLogController],
  providers: [BusinessLogService, OpenSearchService],
  exports: [BusinessLogService],
})
export class BusinessLogModule {}
