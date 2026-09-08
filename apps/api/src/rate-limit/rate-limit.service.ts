import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { closeRedisClient, createRedisClient, type ManagedRedisClient } from '../redis/redis-connection';

const consumeScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly client: ManagedRedisClient;

  constructor(config: ConfigService) {
    this.client = createRedisClient(config, {
      maxRetriesPerRequest: 1,
      commandTimeout: 1_500,
    });
    this.client.on('error', (error) =>
      this.logger.warn(`Redis 限流连接异常: ${error.message}`),
    );
  }

  async consume(key: string, windowMs: number) {
    const result = await this.client.eval(
      consumeScript,
      1,
      `codegen:rate-limit:{${key}}`,
      String(windowMs),
    ) as [number, number];
    return { count: Number(result[0]), ttlMs: Math.max(0, Number(result[1])) };
  }

  async onModuleDestroy() {
    await closeRedisClient(this.client);
  }
}
