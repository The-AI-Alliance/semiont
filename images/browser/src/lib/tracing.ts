/**
 * The Browser's OpenTelemetry tracer. `main.tsx` loads it — by dynamic
 * import, so the web SDK stays out of the bundle unless a collector is
 * configured — and calls `initObservabilityWeb` once.
 *
 * It lives here, not in `@semiont/observability`, because the Browser is its
 * one user: in that package it made every server that traces carry a browser
 * tracing SDK it never loads.
 *
 * Configuration for the browser doesn't read env vars; the SPA passes
 * config explicitly. CORS-allowed OTLP endpoints only — operators
 * typically run a collector that exposes a CORS-enabled `/v1/traces`
 * endpoint.
 *
 * Without an `otlpEndpoint`, falls back to a console exporter (visible
 * in DevTools).
 */

import { context, propagation, trace } from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  StackContextManager,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface WebObservabilityConfig {
  /** Service identity (e.g. `semiont-browser`). */
  serviceName: string;
  /** Service version: the Browser's own, as its package names it. */
  serviceVersion: string;
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

let providerInstance: TracerProvider | undefined;

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

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
  });

  providerInstance = new TracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor({ exporter })],
  });

  // The provider, the context manager a browser has, and the W3C
  // trace-context and baggage propagators: what the web SDK's
  // `register()` installed before it was folded into `sdk-trace`.
  trace.setGlobalTracerProvider(providerInstance);
  context.setGlobalContextManager(new StackContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );
  return true;
}
