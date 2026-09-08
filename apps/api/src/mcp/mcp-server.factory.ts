import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/server';
import type { AuthUser } from '../auth/jwt.strategy';
import { McpToolCatalogService } from './mcp-tool-catalog.service';

export interface McpPrincipal extends AuthUser {
  clientId: string;
}

@Injectable()
export class McpServerFactory {
  constructor(
    private readonly config: ConfigService,
    private readonly catalog: McpToolCatalogService,
  ) {}

  create(principal: McpPrincipal) {
    const server = new McpServer({
      name: 'code-generator',
      version: this.config.get<string>('APP_VERSION', 'development'),
    });

    this.catalog.register(server, principal);

    return server;
  }
}
