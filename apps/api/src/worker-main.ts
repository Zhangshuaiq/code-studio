import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { createServer } from 'node:http';
import { WorkerAppModule } from './worker-app.module';
import { AgentWorkerService } from './agent/agent-worker.service';

async function bootstrap() {
  // 必须在 ConfigModule 初始化前声明，使所有周期维护服务只在 Worker 装载定时器。
  process.env.PROCESS_ROLE = 'worker';
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  const worker = app.get(AgentWorkerService);
  const port = config.get<number>('WORKER_HEALTH_PORT', 3001);
  const healthServer = createServer(async (request, response) => {
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
  healthServer.listen(port, '0.0.0.0');
  app.enableShutdownHooks();
  const closeHealthServer = () => healthServer.close();
  process.once('SIGTERM', closeHealthServer);
  process.once('SIGINT', closeHealthServer);
  Logger.log(`生成 Worker 进程已启动 pid=${process.pid} healthPort=${port}`, 'WorkerBootstrap');
}

bootstrap().catch((error) => {
  Logger.error(error instanceof Error ? error.stack : String(error), 'WorkerBootstrap');
  process.exitCode = 1;
});
