import { ConfigService } from '@nestjs/config';
import type { ConnectionOptions } from 'bullmq';
import { closeRedisClient, createRedisClient } from '../redis/redis-connection';

export const SCHEDULED_TASK_QUEUE_NAME = 'codegen-java-scheduled-tasks';
export interface ScheduledTaskJob { executionId: string; traceContext?: Record<string, string> }
export function createScheduledTaskQueueConnection(config: ConfigService) {
  const client = createRedisClient(config, { maxRetriesPerRequest: null });
  return { connection: client as ConnectionOptions, close: () => closeRedisClient(client) };
}
