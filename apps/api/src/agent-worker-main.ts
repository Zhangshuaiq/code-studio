import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { createServer } from 'node:http';
import { AgentWorkerAppModule } from './agent-worker-app.module';
import { AgentWorkerService } from './agent/agent-worker.service';

async function bootstrap() {
  process.env.PROCESS_ROLE = 'agent-worker';
  const app = await NestFactory.createApplicationContext(AgentWorkerAppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  const worker = app.get(AgentWorkerService);
  const port = Number(config.get('AGENT_WORKER_HEALTH_PORT', 3002));
  const server = createServer(async (request, response) => {
    if (request.url !== '/health/live' && request.url !== '/health/ready') {
      response.writeHead(404).end();
      return;
    }
    const result = request.url === '/health/live'
      ? { available: true, status: 'ok' }
      : await worker.health();
    response.writeHead(result.available ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  server.listen(port, '0.0.0.0');
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
  Logger.log(`独立编码 Worker 已启动 pid=${process.pid} healthPort=${port}`, 'AgentWorkerBootstrap');
}

bootstrap().catch((error) => {
  Logger.error(error instanceof Error ? error.stack : String(error), 'AgentWorkerBootstrap');
  process.exitCode = 1;
});
