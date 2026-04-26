/**
 * Web SDK initialization. Call once at the SPA bootstrap (e.g.
 * `apps/frontend/src/main.tsx`).
 *
 * Configuration for the browser doesn't read env vars; the SPA passes
 * config explicitly. CORS-allowed OTLP endpoints only — operators
 * typically run a collector that exposes a CORS-enabled `/v1/traces`
 * endpoint.
 *
 * Without an `otlpEndpoint`, falls back to a console exporter (visible
 * in DevTools).
 */

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface WebObservabilityConfig {
  /** Service identity (e.g. `semiont-frontend`). */
  serviceName: string;
  /** Service version. */
  serviceVersion?: string;
  /**
   * OTLP HTTP endpoint (e.g. `https://collector.example.com/v1/traces`).
   * If omitted, the SDK uses a console exporter.
   */
  otlpEndpoint?: string;
  /** Optional headers (e.g. SaaS APM auth). */
  otlpHeaders?: Record<string, string>;
  /**
   * Force on (`true`) or force off (`false`). When omitted, the SDK
   * initializes if `otlpEndpoint` is present, otherwise off.
   */
  enabled?: boolean;
}

let providerInstance: WebTracerProvider | undefined;

/**
 * Initialize OTel for the SPA. Idempotent. Returns `true` if the SDK
 * started, `false` if disabled or already initialized.
 */
export function initObservabilityWeb(config: WebObservabilityConfig): boolean {
  if (providerInstance) return false;
  const enabled = config.enabled ?? Boolean(config.otlpEndpoint);
  if (!enabled) return false;

  const exporter = config.otlpEndpoint
    ? new OTLPTraceExporter({
        url: config.otlpEndpoint,
        ...(config.otlpHeaders ? { headers: config.otlpHeaders } : {}),
      })
    : new ConsoleSpanExporter();

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
  });

  providerInstance = new WebTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  providerInstance.register();
  return true;
}
