import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { ApiExceptionFilter } from "./common/api-exception.filter";

async function bootstrap() {
  // API 进程只处理请求；周期维护统一由独立 Worker 承担。
  process.env.PROCESS_ROLE = 'api';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const config = app.get(ConfigService);
  const trustProxy = config.get<string>('TRUST_PROXY', 'false');
  if (trustProxy !== 'false') {
    app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true');
  }
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }));

  // 日志采集使用批量 JSON；限制为 2 MiB，避免默认 100 KiB 过小，也防止无界请求体。
  app.useBodyParser("json", { limit: "2mb" });
  app.useBodyParser("urlencoded", { limit: "2mb", extended: true });

  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());

  const allowedOrigins = config.get<string>('WEB_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  const port = config.get<number>("API_PORT", 3000);
  await app.listen(port);
  Logger.log(`🚀 API 已启动: http://localhost:${port}/api`, "Bootstrap");
}
bootstrap().catch((error) => {
  Logger.error(error instanceof Error ? error.stack : String(error), 'Bootstrap');
  process.exitCode = 1;
});
