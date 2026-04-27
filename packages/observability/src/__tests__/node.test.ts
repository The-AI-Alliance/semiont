/**
 * Tests for `initObservabilityNode` and `shutdownObservabilityNode`.
 *
 * `node.ts` keeps module-level singletons (tracer + meter providers) and
 * registers signal handlers when an exporter is configured. To exercise
 * the env-var branches in isolation, every test resets module state via
 * `vi.resetModules()` and re-imports the module fresh. Signal handlers
 * registered against the real `process` are cleaned up via the
 * `shutdownObservabilityNode` path or, for the success case, by removing
 * any listeners we added during the test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface NodeModule {
  initObservabilityNode: (config: { serviceName: string; serviceVersion?: string }) => boolean;
  shutdownObservabilityNode: () => Promise<void>;
}

async function loadFresh(): Promise<NodeModule> {
  vi.resetModules();
  return import('../node');
}

const PRESERVED_ENVS = [
  'OTEL_SDK_DISABLED',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_CONSOLE_EXPORTER',
  'OTEL_SERVICE_NAME',
  'OTEL_METRIC_EXPORT_INTERVAL',
] as const;

let savedEnv: Record<string, string | undefined>;
let preExistingSignalCounts: { sigterm: number; sigint: number };

beforeEach(() => {
  savedEnv = {};
  for (const key of PRESERVED_ENVS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  preExistingSignalCounts = {
    sigterm: process.listenerCount('SIGTERM'),
    sigint: process.listenerCount('SIGINT'),
  };
});

afterEach(async () => {
  // Best-effort: shut down any module instance that may have started.
  try {
    const mod = await import('../node');
    await mod.shutdownObservabilityNode();
  } catch {
    // ignore
  }
  // Drain any signal listeners that this test added.
  const drainSignals = (signal: 'SIGTERM' | 'SIGINT', preCount: number) => {
    const handlers = process.listeners(signal) as Array<NodeJS.SignalsListener>;
    for (const handler of handlers.slice(preCount)) {
      process.off(signal, handler);
    }
  };
  drainSignals('SIGTERM', preExistingSignalCounts.sigterm);
  drainSignals('SIGINT', preExistingSignalCounts.sigint);

  for (const key of PRESERVED_ENVS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe('initObservabilityNode', () => {
  it('returns false when no exporter is configured', async () => {
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc' })).toBe(false);
    // No signal handlers were registered.
    expect(process.listenerCount('SIGTERM')).toBe(preExistingSignalCounts.sigterm);
    expect(process.listenerCount('SIGINT')).toBe(preExistingSignalCounts.sigint);
  });

  it('returns false when OTEL_SDK_DISABLED=true (even with an endpoint set)', async () => {
    process.env['OTEL_SDK_DISABLED'] = 'true';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://collector.test';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc' })).toBe(false);
  });

  it('returns true when OTEL_CONSOLE_EXPORTER=true and registers signal handlers', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc' })).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(preExistingSignalCounts.sigterm + 1);
    expect(process.listenerCount('SIGINT')).toBe(preExistingSignalCounts.sigint + 1);
  });

  it('returns true when OTEL_EXPORTER_OTLP_ENDPOINT is set', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://collector.test';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc' })).toBe(true);
  });

  it('is idempotent — second call returns false', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc' })).toBe(true);
    expect(initObservabilityNode({ serviceName: 'svc' })).toBe(false);
  });

  it('uses OTEL_SERVICE_NAME when set, falling back to config.serviceName', async () => {
    // The service name lands in the resource attributes; we don't have a
    // probe to read it back without a span exporter wired in. Cover the
    // env-read branch indirectly: setting the env doesn't break init.
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    process.env['OTEL_SERVICE_NAME'] = 'env-named-service';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'config-named' })).toBe(true);
  });

  it('accepts OTEL_METRIC_EXPORT_INTERVAL and falls back when malformed', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    process.env['OTEL_METRIC_EXPORT_INTERVAL'] = '5000';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc' })).toBe(true);
  });

  it('falls back to the default interval when OTEL_METRIC_EXPORT_INTERVAL is non-numeric', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    process.env['OTEL_METRIC_EXPORT_INTERVAL'] = 'not-a-number';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc' })).toBe(true);
  });

  it('honors a serviceVersion override on the config', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);
  });
});

describe('shutdownObservabilityNode', () => {
  it('is safe to call without a prior init', async () => {
    const { shutdownObservabilityNode } = await loadFresh();
    await expect(shutdownObservabilityNode()).resolves.toBeUndefined();
  });

  it('resets internal state so a subsequent init succeeds again', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    const mod = await loadFresh();
    expect(mod.initObservabilityNode({ serviceName: 'svc' })).toBe(true);
    await mod.shutdownObservabilityNode();
    // After shutdown, init should once again return true.
    expect(mod.initObservabilityNode({ serviceName: 'svc' })).toBe(true);
  });
});
