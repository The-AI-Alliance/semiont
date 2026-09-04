/**
 * Node SDK initialization. Call once at the process entry point
 * (gateway `index.ts`, `worker-main.ts`, `smelter-main.ts`).
 *
 * Configuration is via standard `OTEL_*` env vars:
 *   - `OTEL_SERVICE_NAME`           — service identity (e.g. `semiont-gateway`)
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
 *
 * Implementation note: this module wires `BasicTracerProvider` and
 * `MeterProvider` (both from the stable `@opentelemetry/sdk-trace-base`
 * 2.x line) directly, plus `AsyncLocalStorageContextManager` for Node
 * async-context propagation. We deliberately avoid `@opentelemetry/sdk-node`
 * because its `0.x` experimental versions cross-depend on older 2.0.x
 * SDKs, forcing npm to nest duplicate copies of the stable packages and
 * blowing up bundles for every consumer.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { heapStats } from './runtime-stats';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
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
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface NodeObservabilityConfig {
  /** Service identity (e.g. `semiont-gateway`). Overridden by `OTEL_SERVICE_NAME`. */
  serviceName: string;
  /** Service version. Defaults to `0.0.0` if omitted. */
  serviceVersion?: string;
}

let tracerProviderInstance: BasicTracerProvider | undefined;
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
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
  });

  // Trace SDK
  const traceExporter = endpoint ? new OTLPTraceExporter() : new ConsoleSpanExporter();
  tracerProviderInstance = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });

  // Async-context propagation across `await` boundaries — equivalent
  // to what NodeSDK installs internally, but pinned to the stable 2.x
  // cohort.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(tracerProviderInstance);

  // W3C trace-context propagator. Without this, `propagation.inject`
  // and `propagation.extract` walk an empty propagator chain and
  // silently do nothing — which means traceparent never makes it onto
  // outgoing HTTP headers or SSE `_trace` payloads, and cross-service
  // traces stay disconnected. NodeSDK registers this for you; bare
  // BasicTracerProvider does not.
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

  // Event-loop lag (ARCHIVIST-STAYS-UP P7). The cause-AGNOSTIC detector for a
  // blocked process: it rises whether the cause is a synchronous git
  // subprocess, a large JSON parse, or GC. Cheap — libuv keeps the histogram;
  // we read percentiles and reset once per export interval.
  //
  // It earns its place because the Archivist runs `execFileSync('git', …)` on
  // this loop once per appended event: while that blocks, every concurrent
  // `browse:*` read waits, and nothing else in the stack says so.
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const runtimeMeter = meterProviderInstance.getMeter('semiont-runtime');
  runtimeMeter
    .createObservableGauge('semiont.runtime.event_loop.lag', {
      description: 'Event-loop delay percentiles over the last export interval. Time the process could not serve anything.',
      unit: 'ms',
    })
    .addCallback((observer) => {
      observer.observe(loopDelay.mean / 1e6, { 'lag.stat': 'mean' });
      observer.observe(loopDelay.percentile(99) / 1e6, { 'lag.stat': 'p99' });
      observer.observe(loopDelay.max / 1e6, { 'lag.stat': 'max' });
      loopDelay.reset();
    });

  // Heap (ARCHIVIST-STAYS-UP P4), on the SAME registration as lag rather than
  // a second mechanism — they are read together when diagnosing a process
  // that stopped answering, and splitting them would mean two things to wire.
  //
  // `limit` is the field that repays the effort: the Archivist died at
  // ~1016 MB inside a 2048 MB container because V8's own default ceiling sits
  // well under the container's. `used` alone cannot say how close to death a
  // process is, and `limit` is what a configured --max-old-space-size changes
  // — so this is also how that setting is VERIFIED rather than assumed.
  runtimeMeter
    .createObservableGauge('semiont.runtime.heap', {
      description: "Process memory by kind. `limit` is V8's own ceiling, which is what the process dies at — not the container's allocation.",
      unit: 'By',
    })
    .addCallback((observer) => {
      const s = heapStats();
      observer.observe(s.heapUsed, { 'heap.stat': 'used' });
      observer.observe(s.heapTotal, { 'heap.stat': 'total' });
      observer.observe(s.heapLimit, { 'heap.stat': 'limit' });
      observer.observe(s.rss, { 'heap.stat': 'rss' });
    });

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
