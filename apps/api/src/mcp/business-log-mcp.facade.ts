import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/jwt.strategy';
import { BusinessLogService } from '../business-log/business-log.service';
import { ApplicationMetricsDto } from '../business-log/dto/business-log.dto';

interface MetricsInput {
  projectId: string;
  from: string;
  to: string;
  environment?: string;
  serviceName?: string;
}

@Injectable()
export class BusinessLogMcpFacade {
  constructor(private readonly logs: BusinessLogService) {}

  applicationMetrics(user: AuthUser, input: MetricsInput) {
    return this.logs.applicationMetrics(user, Object.assign(new ApplicationMetricsDto(), input));
  }

  platformMetrics(user: AuthUser, input: MetricsInput) {
    return this.logs.platformMetrics(user, Object.assign(new ApplicationMetricsDto(), input));
  }
}
