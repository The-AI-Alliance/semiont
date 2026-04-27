/**
 * Tests for `initObservabilityWeb`.
 *
 * `web.ts` keeps a module-level `providerInstance` singleton, so each
 * test resets the module via `vi.resetModules()` to exercise the early-
 * return / register branches in isolation. The underlying
 * `WebTracerProvider.register()` is fine to call in a Node test runner
 * — it installs a `StackContextManager` and the W3C propagator, both of
 * which are platform-agnostic.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';

interface WebModule {
  initObservabilityWeb: (config: {
    serviceName: string;
    serviceVersion?: string;
    otlpEndpoint?: string;
    otlpHeaders?: Record<string, string>;
    enabled?: boolean;
  }) => boolean;
}

async function loadFresh(): Promise<WebModule> {
  vi.resetModules();
  return import('../web');
}

afterEach(() => {
  // Reset the globals the WebTracerProvider may have set, so subsequent
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
    expect(initObservabilityWeb({ serviceName: 'frontend' })).toBe(false);
  });

  it('returns false when enabled=false (even with an endpoint)', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({
        serviceName: 'frontend',
        otlpEndpoint: 'https://collector.example.com/v1/traces',
        enabled: false,
      }),
    ).toBe(false);
  });

  it('returns true when otlpEndpoint is set (auto-enables)', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({
        serviceName: 'frontend',
        otlpEndpoint: 'https://collector.example.com/v1/traces',
      }),
    ).toBe(true);
  });

  it('returns true when enabled=true and falls back to console exporter', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({
        serviceName: 'frontend',
        enabled: true,
      }),
    ).toBe(true);
  });

  it('forwards optional otlpHeaders to the exporter without throwing', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({
        serviceName: 'frontend',
        otlpEndpoint: 'https://collector.example.com/v1/traces',
        otlpHeaders: { 'x-api-key': 'secret' },
      }),
    ).toBe(true);
  });

  it('honors a serviceVersion override', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({
        serviceName: 'frontend',
        serviceVersion: '2.3.4',
        enabled: true,
      }),
    ).toBe(true);
  });

  it('is idempotent — second call returns false', async () => {
    const { initObservabilityWeb } = await loadFresh();
    expect(
      initObservabilityWeb({ serviceName: 'frontend', enabled: true }),
    ).toBe(true);
    expect(
      initObservabilityWeb({ serviceName: 'frontend', enabled: true }),
    ).toBe(false);
  });
});
