import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PlatformHealthService } from './platform-health.service';

@Controller('health')
export class HealthProbeController {
  constructor(private readonly health: PlatformHealthService) {}

  @Get('live')
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Get('ready')
  async ready() {
    const result = await this.health.overview();
    if (result.status !== 'healthy') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
