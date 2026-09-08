# 多语言 OpenTelemetry 接入

所有语言统一发送 OTLP 到 OpenTelemetry Collector，并使用 W3C Trace Context。推荐通过环境变量统一资源标签：

```bash
OTEL_SERVICE_NAME=order-service
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_RESOURCE_ATTRIBUTES=service.namespace=commerce,service.version=1.2.0,deployment.environment.name=production
OTEL_PROPAGATORS=tracecontext,baggage
```

## Node.js

安装 OpenTelemetry Node SDK、OTLP HTTP Exporter 与自动插桩，并在加载业务模块前启动 SDK。本平台 API/Worker 的实现见 `apps/api/src/instrumentation.ts`。

BullMQ 等消息必须在生产者调用 `propagation.inject()`，把 carrier 放入 job data；消费者调用 `propagation.extract()` 并在 `context.with()` 内执行业务。

## Java

推荐使用 OpenTelemetry Java Agent，无需修改大部分 Spring、HTTP、JDBC、Kafka 代码：

```bash
java -javaagent:/opt/opentelemetry-javaagent.jar \
  -Dotel.service.name=order-service \
  -Dotel.exporter.otlp.endpoint=http://otel-collector:4318 \
  -jar app.jar
```

自定义线程池必须传播当前 Context：

```java
Context context = Context.current();
executor.submit(context.wrap(() -> service.refresh()));
```

## Go

初始化 `TracerProvider`、OTLP HTTP Exporter 和 `TraceContext` propagator。HTTP 使用 `otelhttp`，gRPC 使用官方拦截器，方法参数持续传递 `context.Context`：

```go
func Refresh(ctx context.Context) {
    ctx, span := tracer.Start(ctx, "business.refresh")
    defer span.End()
    go func(child context.Context) { rebuild(child) }(ctx)
}
```

## Python

安装 `opentelemetry-distro` 与 OTLP Exporter，执行自动插桩：

```bash
opentelemetry-instrument python -m app
```

asyncio 使用 `contextvars` 自动传播；自定义线程池需要复制 Context：

```python
ctx = contextvars.copy_context()
executor.submit(ctx.run, refresh)
```

## Browser

使用 WebTracerProvider、Fetch/XHR 与 DocumentLoad 插桩。只对可信 API 域名设置 `propagateTraceHeaderCorsUrls`；Collector Gateway 必须配置明确的 CORS 来源，禁止使用携带凭据的通配符。

浏览器侧禁止采集密码、Token、请求正文和用户敏感字段。Browser SDK 的 `telemetry.sdk.language` 通常为 `webjs`，平台会映射为 Browser 标签。

## 验证

1. 请求经过至少两个服务；
2. 在应用监控 → 链路追踪按服务或语言搜索；
3. 确认所有 Span 具有相同 Trace ID；
4. 检查异步线程和消息消费 Span 的父关系；
5. 检查错误 Span 是否包含异常事件且能关联同 Trace ID 日志。
