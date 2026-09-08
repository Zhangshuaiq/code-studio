import { ConfigService } from '@nestjs/config';
import type { ConnectionOptions } from 'bullmq';
import type { RunResult } from './agent.service';
import { closeRedisClient, createRedisClient } from '../redis/redis-connection';

export interface GenerationJob {
  taskId: string;
  userId: string;
  sessionId: string;
  prompt: string;
  traceContext?: Record<string, string>;
}

export const GENERATION_QUEUE_NAME = 'codegen-generation';

export interface GenerationQueueConnection {
  connection: ConnectionOptions;
  close?: () => Promise<void>;
}

export function createGenerationQueueConnection(
  config: ConfigService,
): GenerationQueueConnection {
  const client = createRedisClient(config, {
    maxRetriesPerRequest: null,
  });
  return {
    connection: client as ConnectionOptions,
    close: () => closeRedisClient(client),
  };
}

export type GenerationResult = RunResult;
