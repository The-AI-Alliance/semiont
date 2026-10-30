/**
 * Tests for `initObservabilityWeb`.
 *
 * `tracing.ts` keeps a module-level `providerInstance` singleton, so each
 * test resets the module via `vi.resetModules()` to exercise the early-
 * return / install branches in isolation. What it installs is fine in a
 * Node test runner: a `StackContextManager` and the W3C propagators are
 * platform-agnostic.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';

type WebModule = typeof import('../tracing');

async function loadFresh(): Promise<WebModule> {
  vi.resetModules();
  return import('../tracing');
}

afterEach(() => {
  // Reset the globals `initObservabilityWeb` may have set, so subsequent
  // tests start from a clean slate.
  trace.disable();
  propagation.disable();
  context.disable();
  // `context.disable()` returns the no-op manager; reset to ROOT_CONTEXT
  // so spans started in subsequent tests don't see a stale active context.
  void ROOT_CONTEXT;
});

describe('initObservabilityWeb', () => {
  it('returns false when neither otlpEndpoint nor enabled is provided', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(initObservabilityWeb({ serviceName: 'semiont-browser', serviceVersion: '1.2.3' })).toBe(false);
  });

  it('returns false when enabled=false (even with an endpoint)', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({
        serviceName: 'semiont-browser', serviceVersion: '1.2.3',
        otlpEndpoint: 'https://collector.example.com/v1/traces',
        enabled: false,
      }),
    ).toBe(false);
  });

  it('returns true when otlpEndpoint is set (auto-enables)', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({
        serviceName: 'semiont-browser', serviceVersion: '1.2.3',
        otlpEndpoint: 'https://collector.example.com/v1/traces',
      }),
    ).toBe(true);
  });

  it('returns true when enabled=true and falls back to console exporter', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({
        serviceName: 'semiont-browser', serviceVersion: '1.2.3',
        enabled: true,
      }),
    ).toBe(true);
  });

  it('forwards optional otlpHeaders to the exporter without throwing', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({
        serviceName: 'semiont-browser', serviceVersion: '1.2.3',
        otlpEndpoint: 'https://collector.example.com/v1/traces',
        otlpHeaders: { 'x-api-key': 'secret' },
      }),
    ).toBe(true);
  });

  it('installs a recording tracer, a context manager and the W3C trace-context and baggage propagators', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(initObservabilityWeb({ serviceName: 'semiont-browser', serviceVersion: '1.2.3', enabled: true })).toBe(true);

    const span = trace.getTracer('probe').startSpan('probe');
    expect(span.isRecording()).toBe(true);
    const within = trace.setSpan(context.active(), span);
    context.with(within, () => {
      expect(trace.getActiveSpan()).toBe(span);
    });
    const carrier: Record<string, string> = {};
    propagation.inject(within, carrier);
    expect(Object.keys(carrier)).toContain('traceparent');
    expect(propagation.fields()).toEqual(expect.arrayContaining(['traceparent', 'tracestate', 'baggage']));
    span.end();
  });

  it('is idempotent — second call returns false', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({ serviceName: 'semiont-browser', serviceVersion: '1.2.3', enabled: true }),
    ).toBe(true);
    expect(
      initObservabilityWeb({ serviceName: 'semiont-browser', serviceVersion: '1.2.3', enabled: true }),
    ).toBe(false);
  });
});
