import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class McpEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(_context: ExecutionContext) {
    if (this.config.get<string>('MCP_ENABLED', 'false') !== 'true') {
      throw new NotFoundException();
    }
    return true;
  }
}
