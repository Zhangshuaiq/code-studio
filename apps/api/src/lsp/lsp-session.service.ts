import {
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { ProjectAccessService } from '../project-access/project-access.service';
import {
  closeRedisClient,
  createRedisClient,
  type ManagedRedisClient,
} from '../redis/redis-connection';
import { WorkspaceService } from '../workspace/workspace.service';
import type { LspLanguage } from './dto/create-lsp-session.dto';

const SESSION_PREFIX = 'lsp:session:';
const TICKET_PREFIX = 'lsp:ticket:';

export type LspSessionStatus =
  | 'awaiting_worker'
  | 'starting'
  | 'ready'
  | 'disconnected'
  | 'failed';

export interface LspSessionRecord {
  id: string;
  tenantId: string;
  userId: string;
  projectId: string;
  sourceSessionId: string;
  workspaceKey: string;
  workspacePath: string;
  branch: string;
  language: LspLanguage;
  status: LspSessionStatus;
  workerId: string;
  workspaceVersion: string;
  createdAt: string;
  lastActiveAt: string;
}

@Injectable()
export class LspSessionService implements OnModuleDestroy {
  private readonly redis: ManagedRedisClient;
  private readonly enabled: boolean;
  private readonly ticketTtlSeconds: number;
  private readonly sessionTtlSeconds: number;

  constructor(
    config: ConfigService,
    private readonly access: ProjectAccessService,
    private readonly workspaces: WorkspaceService,
  ) {
    this.enabled = config.get<string>('LSP_ENABLED', 'false') === 'true';
    this.ticketTtlSeconds = Number(config.get('LSP_TICKET_TTL_SECONDS', 60));
    this.sessionTtlSeconds = Number(config.get('LSP_SESSION_TTL_SECONDS', 1800));
    this.redis = createRedisClient(config, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  }

  async create(userId: string, sourceSessionId: string, language: LspLanguage) {
    this.assertEnabled();
    const sourceSession = await this.access.requireSession(
      userId,
      sourceSessionId,
      'read',
    );
    const workspace = await this.workspaces.ensureForSession(
      userId,
      sourceSessionId,
    );
    const id = randomUUID();
    const now = new Date().toISOString();
    const workspaceKey = digest(
      ['default', userId, sourceSession.projectId, workspace.branch].join(':'),
    );
    const record: LspSessionRecord = {
      id,
      tenantId: 'default',
      userId,
      projectId: sourceSession.projectId,
      sourceSessionId,
      workspaceKey,
      workspacePath: workspace.path,
      branch: workspace.branch,
      language,
      status: 'awaiting_worker',
      workerId: '',
      workspaceVersion: '0',
      createdAt: now,
      lastActiveAt: now,
    };
    const ticket = randomBytes(32).toString('base64url');
    await this.redis
      .multi()
      .set(`${SESSION_PREFIX}${id}`, JSON.stringify(record), 'EX', this.sessionTtlSeconds)
      .set(`${TICKET_PREFIX}${digest(ticket)}`, id, 'EX', this.ticketTtlSeconds)
      .exec();
    return {
      id,
      language,
      status: record.status,
      workspaceKey,
      ticket,
      ticketExpiresIn: this.ticketTtlSeconds,
      websocketUrl: '/lsp/connect',
      authentication: 'first-message',
    };
  }

  async getForUser(userId: string, sourceSessionId: string, id: string) {
    const record = await this.read(id);
    if (record.userId !== userId || record.sourceSessionId !== sourceSessionId) {
      throw this.notFound();
    }
    await this.access.requireSession(userId, sourceSessionId, 'read');
    return publicRecord(record);
  }

  async closeForUser(userId: string, sourceSessionId: string, id: string) {
    const record = await this.read(id);
    if (record.userId !== userId || record.sourceSessionId !== sourceSessionId) {
      throw this.notFound();
    }
    await this.redis.del(`${SESSION_PREFIX}${id}`);
    return { id, closed: true };
  }

  /** WebSocket Gateway 使用：票据只允许消费一次，原始票据不会写入 Redis。 */
  async consumeTicket(ticket: string): Promise<LspSessionRecord> {
    this.assertEnabled();
    if (!ticket || ticket.length > 256) throw this.notFound();
    const key = `${TICKET_PREFIX}${digest(ticket)}`;
    const sessionId = await this.redis.getdel(key);
    if (!sessionId) throw this.notFound();
    const record = await this.read(sessionId);
    // 创建票据后项目角色可能被撤销，真正建立数据连接前必须再次校验。
    await this.access.requireSession(
      record.userId,
      record.sourceSessionId,
      'read',
    );
    return record;
  }

  async onModuleDestroy() {
    await closeRedisClient(this.redis);
  }

  private async read(id: string): Promise<LspSessionRecord> {
    this.assertEnabled();
    const raw = await this.redis.get(`${SESSION_PREFIX}${id}`);
    if (!raw) throw this.notFound();
    return JSON.parse(raw) as LspSessionRecord;
  }

  private assertEnabled() {
    if (!this.enabled) {
      throw new ServiceUnavailableException({
        code: 'LSP_DISABLED',
        message: '语言服务器功能尚未启用',
      });
    }
  }

  private notFound() {
    return new NotFoundException({
      code: 'LSP_SESSION_NOT_FOUND',
      message: '语言服务会话不存在或已过期',
    });
  }
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function publicRecord(record: LspSessionRecord) {
  return {
    id: record.id,
    sourceSessionId: record.sourceSessionId,
    projectId: record.projectId,
    workspaceKey: record.workspaceKey,
    branch: record.branch,
    language: record.language,
    status: record.status,
    workerId: record.workerId || null,
    workspaceVersion: record.workspaceVersion,
    createdAt: record.createdAt,
    lastActiveAt: record.lastActiveAt,
  };
}
