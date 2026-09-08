import { All, Controller, Logger, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/jwt.strategy';
import { McpEnabledGuard } from './mcp-enabled.guard';
import { McpServerFactory } from './mcp-server.factory';

type AuthenticatedMcpRequest = Request & { auth?: AuthInfo };

@Controller('mcp')
@UseGuards(McpEnabledGuard, JwtAuthGuard)
export class McpController {
  private readonly logger = new Logger(McpController.name);
  private readonly handler;
  private readonly validateHost;
  private readonly validateOrigin;

  constructor(
    config: ConfigService,
    serverFactory: McpServerFactory,
  ) {
    const allowedHosts = config.get<string>('MCP_ALLOWED_HOSTS', '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    this.validateHost = hostHeaderValidation(allowedHosts);
    this.validateOrigin = originValidation(allowedHosts);
    this.handler = createMcpHandler(
      (context) => {
        const user = context.authInfo?.extra?.user as AuthUser | undefined;
        if (!user) throw new Error('MCP 请求缺少已验证的平台身份');
        return serverFactory.create({ ...user, clientId: context.authInfo?.clientId || 'internal' });
      },
      {
        legacy: 'stateless',
        responseMode: 'json',
        onerror: (error) => this.logger.error(`MCP 协议处理失败: ${error.message}`),
      },
    );
  }

  @All()
  async handle(
    @Req() request: AuthenticatedMcpRequest,
    @Res() response: Response,
    @CurrentUser() user: AuthUser,
  ) {
    if (!this.validateHost(request, response)) return;
    if (!this.validateOrigin(request, response)) return;
    request.auth = {
      token: 'validated-by-platform-jwt',
      clientId: 'codegen-internal',
      scopes: user.permissions,
      extra: { user },
    };
    await toNodeHandler(this.handler, {
      onerror: (error) => this.logger.error(`MCP HTTP 适配失败: ${error.message}`),
    })(request, response, request.body);
  }
}
