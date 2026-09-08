import { ConfigService } from '@nestjs/config';
import { Cluster, Redis, type ClusterNode, type RedisOptions } from 'ioredis';

export type ManagedRedisClient = Redis | Cluster;

export function createRedisClient(
  config: ConfigService,
  overrides: RedisOptions = {},
): ManagedRedisClient {
  const common: RedisOptions = {
    username: config.get<string>('REDIS_USERNAME') || undefined,
    password: config.get<string>('REDIS_PASSWORD') || undefined,
    tls: config.get<string>('REDIS_TLS', 'false') === 'true' ? {} : undefined,
    enableReadyCheck: true,
    ...overrides,
  };
  if (config.get<string>('REDIS_MODE', 'standalone') === 'cluster') {
    return new Cluster(
      parseClusterNodes(config.get<string>('REDIS_CLUSTER_NODES', '')),
      {
        redisOptions: common,
        enableReadyCheck: true,
        scaleReads: config.get<'master' | 'slave' | 'all'>('REDIS_CLUSTER_SCALE_READS', 'master'),
      },
    );
  }
  return new Redis({
    ...common,
    host: config.get<string>('REDIS_HOST', 'localhost'),
    port: Number(config.get('REDIS_PORT', 6379)),
    db: Number(config.get('REDIS_DB', 0)),
  });
}

export function parseClusterNodes(value: string): ClusterNode[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.lastIndexOf(':');
    if (separator <= 0) throw new Error(`非法 Redis Cluster 节点: ${entry}`);
    return { host: entry.slice(0, separator), port: Number(entry.slice(separator + 1)) };
  });
}

export async function closeRedisClient(client: ManagedRedisClient) {
  await client.quit().catch(() => client.disconnect());
}
