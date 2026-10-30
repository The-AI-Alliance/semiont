/**
 * Node SDK initialization. Call once at the process entry point.
 *
 * Configuration is via standard `OTEL_*` env vars:
 *   - `OTEL_SERVICE_NAME`           — service identity (e.g. `my-program`)
 *   - `OTEL_EXPORTER_OTLP_ENDPOINT` — collector endpoint (HTTP)
 *   - `OTEL_TRACES_SAMPLER`         — sampler (default: `parentbased_always_on`)
 *   - `OTEL_TRACES_SAMPLER_ARG`     — sampler ratio (default: `1.0`)
 *   - `OTEL_METRICS_EXPORTER`       — `console` sends metrics to the process's output
 *   - `OTEL_METRIC_EXPORT_INTERVAL` — metric export interval in ms (default: 30000)
 *   - `OTEL_CONSOLE_EXPORTER=true`  — dev-only: emit spans + metrics to the process's output
 *   - `OTEL_SDK_DISABLED=true`      — skip initialization entirely
 *
 * **Off-by-default invariant**: with neither `OTEL_EXPORTER_OTLP_ENDPOINT`
 * nor `OTEL_CONSOLE_EXPORTER=true` set, this function is a no-op and the
 * `@opentelemetry/api` no-op tracer takes over. This avoids accidentally
 * flooding production logs when an operator deploys
 * without configuring an exporter.
 *
 * Implementation note: this module wires `TracerProvider` (from
 * `@opentelemetry/sdk-trace`) and `MeterProvider` (from
 * `@opentelemetry/sdk-metrics`) directly, plus
 * `AsyncLocalStorageContextManager` for Node async-context propagation.
 * `sdk-trace` reads no environment variable, so the sampler is read here.
 * `@opentelemetry/sdk-node` would read them all, and brings with it the
 * gRPC, protobuf, Zipkin and Prometheus exporters and the instrumentation
 * framework, which this package does not use.
 */

import { context, diag, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type Sampler,
} from '@opentelemetry/sdk-trace';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface NodeObservabilityConfig {
  /** Service identity (e.g. `my-program`). Overridden by `OTEL_SERVICE_NAME`. */
  serviceName: string;
  /** Service version: the program's own, as its package names it. */
  serviceVersion: string;
}

let tracerProviderInstance: TracerProvider | undefined;
let meterProviderInstance: MeterProvider | undefined;

/**
 * Default metric export interval. 30s mirrors the SDK default and gives
 * operators enough granularity without flooding the collector.
 */
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 30_000;

/**
 * Which exporter metrics use. `console` wins even with an OTLP endpoint set —
 * the readout for a bare process or CI with no collector; traces unaffected.
 * Any other value (incl. unrecognised) leaves the endpoint to decide, so an
 * unknown value cannot silently disable metrics. Exported and pure so tests
 * assert the choice without mocking the exporter modules.
 */
export function metricsExporterKind(
  endpoint: string | undefined,
  requested: string | undefined,
): 'otlp' | 'console' {
  if (requested === 'console') return 'console';
  return endpoint ? 'otlp' : 'console';
}

/**
 * The sampler `OTEL_TRACES_SAMPLER` names, and the ratio
 * `OTEL_TRACES_SAMPLER_ARG` gives the two that take one, as the
 * OpenTelemetry SDK configuration spec defines them. A value unset, unknown
 * or out of range is logged and treated as unset, as the spec requires:
 * `parentbased_always_on`, and a ratio of 1.
 */
function samplerFromEnvironment(name: string | undefined, arg: string | undefined): Sampler {
  const ratio = (): number => {
    const value = arg === undefined || arg.trim() === '' ? Number.NaN : Number(arg.trim());
    if (value >= 0 && value <= 1) return value;
    diag.error(`OTEL_TRACES_SAMPLER_ARG=${JSON.stringify(arg)} is no ratio from 0 to 1; using 1`);
    return 1;
  };
  const named = name === undefined || name.trim() === '' ? 'parentbased_always_on' : name.trim();
  switch (named) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratio());
    case 'parentbased_always_on':
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio()) });
    default:
      diag.error(`OTEL_TRACES_SAMPLER=${JSON.stringify(named)} is no sampler this package makes; using parentbased_always_on`);
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

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
  if (tracerProviderInstance) return false;
  if (process.env['OTEL_SDK_DISABLED'] === 'true') return false;

  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const useConsole = process.env['OTEL_CONSOLE_EXPORTER'] === 'true';

  // No exporter configured = no SDK init. The `@opentelemetry/api`
  // no-op tracer takes over; `withSpan` still runs `fn` but emits
  // nothing, `getActiveSpan()` returns a sentinel. Avoids flooding
  // production stderr when no collector endpoint is set.
  if (!endpoint && !useConsole) return false;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
  });

  // Trace SDK
  const traceExporter = endpoint ? new OTLPTraceExporter() : new ConsoleSpanExporter();
  tracerProviderInstance = new TracerProvider({
    resource,
    sampler: samplerFromEnvironment(process.env['OTEL_TRACES_SAMPLER'], process.env['OTEL_TRACES_SAMPLER_ARG']),
    spanProcessors: [new BatchSpanProcessor({ exporter: traceExporter })],
  });

  // Async-context propagation across `await` boundaries — what NodeSDK
  // installs internally.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(tracerProviderInstance);

  // W3C trace-context propagator. Without this, `propagation.inject`
  // and `propagation.extract` walk an empty propagator chain and
  // silently do nothing — which means traceparent never makes it onto
  // outgoing HTTP headers or the trace field of SSE payloads, and cross-service
  // traces stay disconnected. NodeSDK registers this for you; a bare
  // TracerProvider does not.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  // Traces follow the endpoint; metrics additionally honour OTEL_METRICS_EXPORTER.
  const metricExporter =
    metricsExporterKind(endpoint, process.env['OTEL_METRICS_EXPORTER']) === 'console'
      ? new ConsoleMetricExporter()
      : new OTLPMetricExporter();
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
      tracerProviderInstance?.shutdown().catch(() => {}),
      meterProviderInstance?.shutdown().catch(() => {}),
    ]).finally(() => {
      tracerProviderInstance = undefined;
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
    tracerProviderInstance?.shutdown(),
    meterProviderInstance?.shutdown(),
  ]);
  tracerProviderInstance = undefined;
  meterProviderInstance = undefined;
}
