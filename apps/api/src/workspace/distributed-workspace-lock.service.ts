import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { closeRedisClient, createRedisClient, type ManagedRedisClient } from '../redis/redis-connection';

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

/** 跨 API/Worker Pod 串行化同一用户工作区、项目仓库结构或部署环境的写操作。 */
@Injectable()
export class DistributedWorkspaceLockService implements OnModuleDestroy {
  private readonly logger = new Logger(DistributedWorkspaceLockService.name);
  private readonly redis: ManagedRedisClient;
  private readonly context = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly leaseMs: number;
  private readonly waitMs: number;

  constructor(config: ConfigService) {
    this.redis = createRedisClient(config, { maxRetriesPerRequest: null });
    this.redis.on('error', (error) => this.logger.warn(`工作区锁 Redis 连接异常: ${error.message}`));
    this.leaseMs = positive(config.get('WORKSPACE_LOCK_LEASE_MS'), 60_000);
    this.waitMs = positive(config.get('WORKSPACE_LOCK_WAIT_MS'), 30_000);
  }

  async runExclusive<T>(resource: string, task: () => Promise<T>): Promise<T> {
    const key = this.key(resource);
    const held = this.context.getStore();
    if (held?.has(key)) return task();

    const token = randomUUID();
    const deadline = Date.now() + this.waitMs;
    while ((await this.redis.set(key, token, 'PX', this.leaseMs, 'NX')) !== 'OK') {
      if (Date.now() >= deadline) throw new Error(`等待工作区锁超时: ${resource}`);
      await delay(100 + Math.floor(Math.random() * 150));
    }

    let lockLost = false;
    let lastConfirmedAt = Date.now();
    const renewal = setInterval(() => {
      void this.redis.eval(RENEW_SCRIPT, 1, key, token, String(this.leaseMs))
        .then((renewed) => {
          if (Number(renewed) === 1) lastConfirmedAt = Date.now();
          else lockLost = true;
        })
        .catch((error) => {
          if (Date.now() - lastConfirmedAt >= this.leaseMs) lockLost = true;
          this.logger.error(`工作区锁续租失败 resource=${resource}: ${(error as Error).message}`);
        });
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    renewal.unref();

    try {
      const next = new Set(held ?? []);
      next.add(key);
      const result = await this.context.run(next, task);
      if (lockLost) throw new Error(`工作区锁在操作期间失效: ${resource}`);
      return result;
    } finally {
      clearInterval(renewal);
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token).catch((error) =>
        this.logger.warn(`释放工作区锁失败 resource=${resource}: ${(error as Error).message}`),
      );
    }
  }

  private key(resource: string) {
    const normalized = resource.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 180);
    return `codegen:workspace-lock:{${normalized}}`;
  }

  async onModuleDestroy() {
    await closeRedisClient(this.redis);
  }
}

function positive(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
