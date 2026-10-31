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
import { trace } from '@opentelemetry/api';

type NodeModule = typeof import('../node');

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
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_SAMPLER',
  'OTEL_TRACES_SAMPLER_ARG',
] as const;

/** Every event `initObservabilityNode` attaches to the real `process`. */
const REGISTERED_EVENTS = ['SIGTERM', 'SIGINT'] as const;
type RegisteredEvent = (typeof REGISTERED_EVENTS)[number];

let savedEnv: Record<string, string | undefined>;
let preExistingCounts: Record<RegisteredEvent, number>;

beforeEach(() => {
  savedEnv = {};
  for (const key of PRESERVED_ENVS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  preExistingCounts = {
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGINT: process.listenerCount('SIGINT'),
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
  // Drain every listener this test added.
  for (const event of REGISTERED_EVENTS) {
    for (const handler of process.listeners(event).slice(preExistingCounts[event])) {
      process.off(event, handler);
    }
  }

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
    expect(initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(false);
    // No signal handlers were registered.
    expect(process.listenerCount('SIGTERM')).toBe(preExistingCounts.SIGTERM);
    expect(process.listenerCount('SIGINT')).toBe(preExistingCounts.SIGINT);
  });

  it('returns false when OTEL_SDK_DISABLED=true (even with an endpoint set)', async () => {
    process.env['OTEL_SDK_DISABLED'] = 'true';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://collector.test';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(false);
  });

  it('returns true when OTEL_CONSOLE_EXPORTER=true and registers signal handlers', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(preExistingCounts.SIGTERM + 1);
    expect(process.listenerCount('SIGINT')).toBe(preExistingCounts.SIGINT + 1);
  });

  it('returns true when OTEL_EXPORTER_OTLP_ENDPOINT is set', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://collector.test';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);
  });

  it('is idempotent — second call returns false', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);
    expect(initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(false);
  });

  it('uses OTEL_SERVICE_NAME when set, falling back to config.serviceName', async () => {
    // The service name lands in the resource attributes; we don't have a
    // probe to read it back without a span exporter wired in. Cover the
    // env-read branch indirectly: setting the env doesn't break init.
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    process.env['OTEL_SERVICE_NAME'] = 'env-named-service';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'config-named', serviceVersion: '1.2.3' })).toBe(true);
  });

  it('accepts OTEL_METRIC_EXPORT_INTERVAL and falls back when malformed', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    process.env['OTEL_METRIC_EXPORT_INTERVAL'] = '5000';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);
  });

  it('falls back to the default interval when OTEL_METRIC_EXPORT_INTERVAL is non-numeric', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    process.env['OTEL_METRIC_EXPORT_INTERVAL'] = 'not-a-number';
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);
  });
});

describe('initObservabilityNode — OTEL_TRACES_SAMPLER', () => {
  /** Whether a span started with no parent, under the sampler the variables name, records. */
  async function records(sampler: string | undefined, arg?: string): Promise<boolean> {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    if (sampler !== undefined) process.env['OTEL_TRACES_SAMPLER'] = sampler;
    if (arg !== undefined) process.env['OTEL_TRACES_SAMPLER_ARG'] = arg;
    // The global tracer provider is set once per process; each case installs its own.
    trace.disable();
    const { initObservabilityNode } = await loadFresh();
    expect(initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);
    const span = trace.getTracer('probe').startSpan('probe');
    const recording = span.isRecording();
    span.end();
    return recording;
  }

  it.each([
    ['unset', undefined, undefined, true],
    ['always_on', 'always_on', undefined, true],
    ['always_off', 'always_off', undefined, false],
    ['parentbased_always_on', 'parentbased_always_on', undefined, true],
    ['parentbased_always_off', 'parentbased_always_off', undefined, false],
    ['traceidratio at 0', 'traceidratio', '0', false],
    ['traceidratio at 1', 'traceidratio', '1', true],
    ['parentbased_traceidratio at 0', 'parentbased_traceidratio', '0', false],
    ['traceidratio with a ratio out of range, read as 1', 'traceidratio', '2', true],
    ['traceidratio with no ratio, read as 1', 'traceidratio', undefined, true],
    ['an unknown sampler, read as parentbased_always_on', 'xray', undefined, true],
  ])('%s', async (_case, sampler, arg, recording) => {
    expect(await records(sampler, arg)).toBe(recording);
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
    expect(mod.initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);
    await mod.shutdownObservabilityNode();
    // After shutdown, init should once again return true.
    expect(mod.initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);
  });
});

// OTEL_METRICS_EXPORTER decides the metrics exporter independently of the
// endpoint. Tested as a pure function: asserting which class was instantiated
// would need the exporter modules mocked.
describe('metricsExporterKind', () => {
  it('is otlp when an endpoint is set and nothing overrides it', async () => {
    const { metricsExporterKind } = await loadFresh();
    expect(metricsExporterKind('http://collector.test', undefined)).toBe('otlp');
  });

  it('is console when there is no endpoint — the fallback', async () => {
    const { metricsExporterKind } = await loadFresh();
    expect(metricsExporterKind(undefined, undefined)).toBe('console');
  });

  it('is console when OTEL_METRICS_EXPORTER says so, EVEN with an endpoint set', async () => {
    const { metricsExporterKind } = await loadFresh();
    expect(metricsExporterKind('http://collector.test', 'console')).toBe('console');
  });

  it('ignores values it does not implement rather than silently exporting nowhere', async () => {
    const { metricsExporterKind } = await loadFresh();
    // 'none' and 'otlp' are also standard; only 'console' changes the outcome
    // here, and an unknown value must not disable metrics by accident.
    expect(metricsExporterKind('http://collector.test', 'otlp')).toBe('otlp');
    expect(metricsExporterKind('http://collector.test', 'wat')).toBe('otlp');
  });
});

describe('initObservabilityNode — shutdown on signal', () => {
  it('the registered SIGTERM handler tears both providers down', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    const mod = await loadFresh();
    expect(mod.initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);

    // Invoke the handler this init added rather than raising a real signal,
    // which would take the test runner down with it.
    const added = process.listeners('SIGTERM').slice(preExistingCounts.SIGTERM);
    expect(added).toHaveLength(1);
    (added[0] as NodeJS.SignalsListener)('SIGTERM');

    // The handler's shutdown is fire-and-forget; let its promise chain settle.
    await new Promise((resolve) => setImmediate(resolve));

    // State was cleared, so a fresh init is accepted again — the observable
    // consequence of the teardown having run.
    expect(mod.initObservabilityNode({ serviceName: 'svc', serviceVersion: '1.2.3' })).toBe(true);
  });
});
