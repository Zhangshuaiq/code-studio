import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

// 计费/凭证模式：
//  - platform：平台一把 key，全平台共用（当前默认）
//  - byok：每个用户自带 key（个人中心加密存储；尚未实现存储）
//  - hybrid：优先用户 key，缺失则回退平台额度
export type BillingMode = 'platform' | 'byok' | 'hybrid';

export interface AgentCredential {
  env: Record<string, string>; // 注入 Agent SDK query() 的鉴权环境变量
  source: 'platform' | 'user';
}

/**
 * 解析本次 Agent 调用该用哪份凭证。
 * 现在模式来源是 env(BILLING_MODE)；后续接后台管控时，把 getMode() 改为读 DB 设置即可，
 * 业务代码不变——这就是留给「后台切换计费模式」的扩展缝。
 */
@Injectable()
export class AgentCredentialResolver {
  private readonly logger = new Logger(AgentCredentialResolver.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  getMode(): BillingMode {
    // TODO(后台管控): 改为从 SettingsService(DB) 读取，支持运行时切换
    return (this.config.get<string>('BILLING_MODE') ?? 'platform') as BillingMode;
  }

  async resolve(userId: string): Promise<AgentCredential> {
    const mode = this.getMode();
    switch (mode) {
      case 'platform':
        return this.platformCredential();
      case 'byok':
        return this.userCredential(userId);
      case 'hybrid':
        try {
          return await this.userCredential(userId);
        } catch {
          this.logger.debug(`用户 ${userId} 无自带 key，回退平台额度`);
          return this.platformCredential();
        }
      default:
        throw new BadRequestException(`未知计费模式: ${mode}`);
    }
  }

  /**
   * 平台凭证，优先级：
   *  1) ANTHROPIC_API_KEY（走 API 计费）
   *  2) CLAUDE_CODE_OAUTH_TOKEN（走 Claude 订阅额度）
   *  3) AGENT_USE_HOST_LOGIN=true 时，复用本机已登录的 Claude Code（不注入任何密钥，
   *     由 SDK 子进程读取本机钥匙串登录态）——仅建议本地开发使用
   */
  private platformCredential(): AgentCredential {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      return { env: { ANTHROPIC_API_KEY: apiKey }, source: 'platform' };
    }
    const oauth = this.config.get<string>('CLAUDE_CODE_OAUTH_TOKEN');
    if (oauth) {
      return { env: { CLAUDE_CODE_OAUTH_TOKEN: oauth }, source: 'platform' };
    }
    if (this.config.get<string>('AGENT_USE_HOST_LOGIN') === 'true') {
      this.logger.debug('复用本机 Claude Code 登录态');
      return { env: {}, source: 'platform' };
    }
    throw new BadRequestException(
      '平台未配置 AI 凭证：请在 .env 设置 ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN，' +
        '或本地开发设 AGENT_USE_HOST_LOGIN=true 复用本机 Claude Code 登录',
    );
  }

  /** BYOK：从用户加密存储取 key（扩展位，尚未接入用户密钥存储） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async userCredential(_userId: string): Promise<AgentCredential> {
    // TODO(BYOK): 读取个人中心的 AES 加密用户 key（复用 CryptoService）
    throw new BadRequestException('BYOK 模式尚未接入用户密钥存储（后续实现）');
  }
}
