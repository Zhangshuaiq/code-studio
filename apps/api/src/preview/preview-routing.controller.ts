import { Controller, Get, Header, Headers, Query } from '@nestjs/common';
import { ResolvePreviewRouteDto } from './dto/preview-route.dto';
import { PreviewRoutingService } from './preview-routing.service';

@Controller('internal/preview-routing')
export class PreviewRoutingController {
  constructor(private readonly routing: PreviewRoutingService) {}

  @Get('resolve')
  @Header('Cache-Control', 'private, no-store')
  resolve(@Headers('x-codegen-routing-token') token: string | undefined, @Query() query: ResolvePreviewRouteDto) {
    this.routing.authorize(token);
    return this.routing.resolve(query.requirementNo, query.serviceKey);
  }
}
