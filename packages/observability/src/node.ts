/**
 * Node SDK initialization. Call once at the process entry point
 * (backend `index.ts`, `worker-main.ts`, `smelter-main.ts`).
 *
 * Configuration is via standard `OTEL_*` env vars:
 *   - `OTEL_SERVICE_NAME`           — service identity (e.g. `semiont-backend`)
 *   - `OTEL_EXPORTER_OTLP_ENDPOINT` — collector endpoint (HTTP)
 *   - `OTEL_TRACES_SAMPLER`         — sampler (default: `parentbased_always_on`)
 *   - `OTEL_TRACES_SAMPLER_ARG`     — sampler ratio (default: `1.0`)
 *   - `OTEL_CONSOLE_EXPORTER=true`  — dev-only: emit spans + metrics to stderr
 *   - `OTEL_SDK_DISABLED=true`      — skip initialization entirely
 *
 * **Off-by-default invariant**: with neither `OTEL_EXPORTER_OTLP_ENDPOINT`
 * nor `OTEL_CONSOLE_EXPORTER=true` set, this function is a no-op and the
 * `@opentelemetry/api` no-op tracer takes over. This avoids accidentally
 * flooding production stderr (and CloudWatch) when an operator deploys
 * without configuring an exporter.
 */

import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface NodeObservabilityConfig {
  /** Service identity (e.g. `semiont-backend`). Overridden by `OTEL_SERVICE_NAME`. */
  serviceName: string;
  /** Service version. Defaults to `0.0.0` if omitted. */
  serviceVersion?: string;
}

let sdkInstance: NodeSDK | undefined;
let meterProviderInstance: MeterProvider | undefined;

/**
 * Default metric export interval. 30s mirrors the SDK default and gives
 * operators enough granularity without flooding the collector.
 */
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 30_000;

/**
 * Initialize OTel for the current process. Wires up both tracing and
 * metrics. Idempotent — calling twice is a no-op. Returns `true` if the
 * SDK started, `false` if disabled, no exporter is configured, or
 * already initialized.
 *
 * Metrics export at `OTEL_METRIC_EXPORT_INTERVAL` ms (default 30s) to
 * the same `OTEL_EXPORTER_OTLP_ENDPOINT` as traces.
 */
export function initObservabilityNode(config: NodeObservabilityConfig): boolean {
  if (sdkInstance) return false;
  if (process.env['OTEL_SDK_DISABLED'] === 'true') return false;

  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const useConsole = process.env['OTEL_CONSOLE_EXPORTER'] === 'true';

  // No exporter configured = no SDK init. The `@opentelemetry/api`
  // no-op tracer takes over; `withSpan` still runs `fn` but emits
  // nothing, `getActiveSpan()` returns a sentinel. Avoids flooding
  // production stderr when no collector endpoint is set.
  if (!endpoint && !useConsole) return false;

  const traceExporter = endpoint
    ? new OTLPTraceExporter()  // reads OTEL_EXPORTER_OTLP_ENDPOINT itself
    : new ConsoleSpanExporter();

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
  });

  // Trace SDK
  sdkInstance = new NodeSDK({
    resource,
    spanProcessor: new BatchSpanProcessor(traceExporter),
  });
  sdkInstance.start();

  // Metric SDK (independent of NodeSDK to keep the metrics path explicit
  // and not entangled with tracing's auto-instrumentation surface).
  // Same exporter selection as traces — endpoint wins, otherwise console
  // (only reachable here when OTEL_CONSOLE_EXPORTER=true).
  const metricExporter = endpoint
    ? new OTLPMetricExporter()
    : new ConsoleMetricExporter();
  const intervalRaw = process.env['OTEL_METRIC_EXPORT_INTERVAL'];
  const exportIntervalMillis = intervalRaw
    ? Number.parseInt(intervalRaw, 10)
    : DEFAULT_METRIC_EXPORT_INTERVAL_MS;

  meterProviderInstance = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: Number.isFinite(exportIntervalMillis) && exportIntervalMillis > 0
          ? exportIntervalMillis
          : DEFAULT_METRIC_EXPORT_INTERVAL_MS,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProviderInstance);

  // Flush traces + metrics on shutdown so nothing is lost on SIGTERM/SIGINT.
  const shutdown = () => {
    Promise.all([
      sdkInstance?.shutdown().catch(() => {}),
      meterProviderInstance?.shutdown().catch(() => {}),
    ]).finally(() => {
      sdkInstance = undefined;
      meterProviderInstance = undefined;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return true;
}

/** Force-flush + shutdown both SDKs. Test cleanup, not production. */
export async function shutdownObservabilityNode(): Promise<void> {
  await Promise.all([
    sdkInstance?.shutdown(),
    meterProviderInstance?.shutdown(),
  ]);
  sdkInstance = undefined;
  meterProviderInstance = undefined;
}
