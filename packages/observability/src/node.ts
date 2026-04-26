/**
 * Node SDK initialization. Call once at the process entry point
 * (backend `index.ts`, `worker-main.ts`, `smelter-main.ts`).
 *
 * Configuration is via standard `OTEL_*` env vars:
 *   - `OTEL_SERVICE_NAME`           — service identity (e.g. `semiont-backend`)
 *   - `OTEL_EXPORTER_OTLP_ENDPOINT` — collector endpoint (HTTP)
 *   - `OTEL_TRACES_SAMPLER`         — sampler (default: `parentbased_traceidratio`)
 *   - `OTEL_TRACES_SAMPLER_ARG`     — sampler ratio (default: `1.0`)
 *
 * Without `OTEL_EXPORTER_OTLP_ENDPOINT`, falls back to a console exporter
 * — useful for dev. When `OTEL_SDK_DISABLED=true`, skips initialization
 * entirely (the api module's no-op tracer takes over).
 */

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
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

/**
 * Initialize OTel for the current process. Idempotent — calling twice is
 * a no-op. Returns `true` if the SDK started, `false` if disabled or
 * already initialized.
 */
export function initObservabilityNode(config: NodeObservabilityConfig): boolean {
  if (sdkInstance) return false;
  if (process.env['OTEL_SDK_DISABLED'] === 'true') return false;

  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const exporter = endpoint
    ? new OTLPTraceExporter()  // reads OTEL_EXPORTER_OTLP_ENDPOINT itself
    : new ConsoleSpanExporter();

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
  });

  sdkInstance = new NodeSDK({
    resource,
    spanProcessor: new BatchSpanProcessor(exporter),
  });

  sdkInstance.start();

  // Flush spans on shutdown so traces aren't lost on SIGTERM/SIGINT.
  const shutdown = () => {
    sdkInstance
      ?.shutdown()
      .catch(() => {})
      .finally(() => {
        sdkInstance = undefined;
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return true;
}

/** Force-flush + shutdown the SDK. Test cleanup, not for production code paths. */
export async function shutdownObservabilityNode(): Promise<void> {
  if (!sdkInstance) return;
  await sdkInstance.shutdown();
  sdkInstance = undefined;
}
