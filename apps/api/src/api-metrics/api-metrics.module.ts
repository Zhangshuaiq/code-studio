import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ApiMetricsInterceptor } from './api-metrics.interceptor';

@Global()
@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: ApiMetricsInterceptor }],
})
export class ApiMetricsModule {}
