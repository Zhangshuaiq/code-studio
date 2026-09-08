import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

let sdk: NodeSDK | undefined;
let shuttingDown: Promise<void> | undefined;

export function startTelemetry() {
  if (process.env.OTEL_ENABLED !== 'true' || sdk) return;
  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || 'codegen-api',
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS || 60_000),
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) => {
            const path = request.url?.split('?')[0] || '';
            return path === '/api/health/live' || path === '/api/health/ready';
          },
        },
      }),
    ],
  });
  sdk.start();
}

export function shutdownTelemetry() {
  if (!sdk) return Promise.resolve();
  shuttingDown ??= sdk.shutdown().finally(() => {
    sdk = undefined;
  });
  return shuttingDown;
}

startTelemetry();
process.once('SIGTERM', () => void shutdownTelemetry());
process.once('SIGINT', () => void shutdownTelemetry());
