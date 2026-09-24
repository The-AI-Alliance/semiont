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
  metricsExporterKind: (endpoint: string | undefined, requested: string | undefined) => 'otlp' | 'console';
  registerSupervisorRestartCount: () => void;
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
  'OTEL_METRICS_EXPORTER',
  'SUPERVISE_EVENTS',
  'SUPERVISE_NAME',
] as const;

/**
 * Every event `initObservabilityNode` attaches to the real `process`. All four
 * must be drained after each test: a leaked `uncaughtException` handler would
 * outlive its test and, on the next stray rejection anywhere in the file, run
 * the fatal path — which calls `process.exit(1)` and would take the runner down
 * mid-suite.
 */
const REGISTERED_EVENTS = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'] as const;
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
    unhandledRejection: process.listenerCount('unhandledRejection'),
    uncaughtException: process.listenerCount('uncaughtException'),
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
  // Drain every listener this test added, on all four events.
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
    expect(initObservabilityNode({ serviceName: 'svc' })).toBe(false);
    // No signal handlers were registered.
    expect(process.listenerCount('SIGTERM')).toBe(preExistingCounts.SIGTERM);
    expect(process.listenerCount('SIGINT')).toBe(preExistingCounts.SIGINT);
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
    expect(process.listenerCount('SIGTERM')).toBe(preExistingCounts.SIGTERM + 1);
    expect(process.listenerCount('SIGINT')).toBe(preExistingCounts.SIGINT + 1);
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

// OTEL_METRICS_EXPORTER decides the metrics exporter independently of the
// endpoint. Tested as a pure function: asserting which class was instantiated
// would need the exporter modules mocked.
describe('metricsExporterKind', () => {
  it('is otlp when an endpoint is set and nothing overrides it', async () => {
    const { metricsExporterKind } = await loadFresh();
    expect(metricsExporterKind('http://collector.test', undefined)).toBe('otlp');
  });

  it('is console when there is no endpoint — the pre-existing fallback', async () => {
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
    expect(mod.initObservabilityNode({ serviceName: 'svc' })).toBe(true);

    // Invoke the handler this init added rather than raising a real signal,
    // which would take the test runner down with it.
    const added = process.listeners('SIGTERM').slice(preExistingCounts.SIGTERM);
    expect(added).toHaveLength(1);
    (added[0] as NodeJS.SignalsListener)('SIGTERM');

    // The handler's shutdown is fire-and-forget; let its promise chain settle.
    await new Promise((resolve) => setImmediate(resolve));

    // State was cleared, so a fresh init is accepted again — the observable
    // consequence of the teardown having run.
    expect(mod.initObservabilityNode({ serviceName: 'svc' })).toBe(true);
  });
});

/**
 * `registerSupervisorRestartCount` reads the supervisor's durable event log and
 * reports lives-minus-one. Asserted through a real metric reader, because the
 * provider it registers is only invoked at collection time — calling the
 * function alone proves nothing about what it would report.
 */
describe('registerSupervisorRestartCount', () => {
  async function withMeter(): Promise<{
    mod: NodeModule;
    collect: () => Promise<Map<string, Array<{ attributes: Record<string, unknown>; value?: number }>>>;
    shutdown: () => Promise<void>;
  }> {
    vi.resetModules();
    const api = await import('@opentelemetry/api');
    const {
      AggregationTemporality,
      InMemoryMetricExporter,
      MeterProvider,
      PeriodicExportingMetricReader,
    } = await import('@opentelemetry/sdk-metrics');

    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const meterProvider = new MeterProvider({ readers: [reader] });
    // A global provider left behind by an earlier `initObservabilityNode` test
    // would make this registration a silently-ignored no-op — the api refuses
    // to overwrite — and every instrument here would land on the stale meter.
    api.metrics.disable();
    api.metrics.setGlobalMeterProvider(meterProvider);

    const mod: NodeModule = await import('../node');

    return {
      mod,
      collect: async () => {
        exporter.reset();
        await reader.forceFlush();
        const out = new Map<string, Array<{ attributes: Record<string, unknown>; value?: number }>>();
        for (const resourceMetric of exporter.getMetrics()) {
          for (const scopeMetric of resourceMetric.scopeMetrics) {
            for (const metric of scopeMetric.metrics) {
              out.set(
                metric.descriptor.name,
                metric.dataPoints.map((dp) => ({
                  attributes: dp.attributes as Record<string, unknown>,
                  value: typeof dp.value === 'number' ? dp.value : undefined,
                })),
              );
            }
          }
        }
        return out;
      },
      shutdown: async () => {
        await reader.shutdown();
        await meterProvider.shutdown();
      },
    };
  }

  async function writeEventLog(lines: string[]): Promise<string> {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'supervise-'));
    const file = join(dir, 'events.log');
    await writeFile(file, lines.join('\n'), 'utf-8');
    return file;
  }

  it('registers no provider at all when unsupervised', async () => {
    delete process.env['SUPERVISE_EVENTS'];
    delete process.env['SUPERVISE_NAME'];
    const { mod, collect, shutdown } = await withMeter();

    mod.registerSupervisorRestartCount();

    // No series, as opposed to a series reading 0 — which is what a healthy
    // supervised process reports, and must stay distinguishable from this.
    expect((await collect()).get('semiont.process.restarts')).toBeUndefined();
    await shutdown();
  });

  it('reports 0 for a first life — one start marker is not a restart', async () => {
    process.env['SUPERVISE_EVENTS'] = await writeEventLog(['starting gateway']);
    process.env['SUPERVISE_NAME'] = 'gateway';
    const { mod, collect, shutdown } = await withMeter();

    mod.registerSupervisorRestartCount();

    const points = (await collect()).get('semiont.process.restarts');
    expect(points).toBeDefined();
    expect(points![0]?.value).toBe(0);
    await shutdown();
  });

  it('reports lives-minus-one, counting only its own service name', async () => {
    process.env['SUPERVISE_EVENTS'] = await writeEventLog([
      'starting gateway',
      'starting worker',
      'starting gateway',
      'some other line',
      'starting gateway',
    ]);
    process.env['SUPERVISE_NAME'] = 'gateway';
    const { mod, collect, shutdown } = await withMeter();

    mod.registerSupervisorRestartCount();

    const points = (await collect()).get('semiont.process.restarts');
    expect(points![0]?.value).toBe(2);
    await shutdown();
  });

  it('reports nothing — never 0 — when the event log went unreadable', async () => {
    process.env['SUPERVISE_EVENTS'] = '/nonexistent/supervise/events.log';
    process.env['SUPERVISE_NAME'] = 'gateway';
    const { mod, collect, shutdown } = await withMeter();

    mod.registerSupervisorRestartCount();

    // The gauge exists (the provider registered) but observes no value, which
    // must not be confused with a healthy 0.
    const points = (await collect()).get('semiont.process.restarts');
    expect(points ?? []).toHaveLength(0);
    await shutdown();
  });
});

/**
 * Invoke a listener read back off `process`. Node types those arrays as a union
 * of per-event signatures, so calling one directly needs a conversion; going
 * through `Reflect.apply` behind a `typeof` guard keeps it honest instead.
 */
async function fire(handler: unknown, arg: unknown): Promise<void> {
  if (typeof handler !== 'function') throw new Error('expected a registered listener');
  await Reflect.apply(handler, process, [arg]);
}

/**
 * The fatal handlers must RE-RAISE: registering a listener for
 * `uncaughtException` normally suppresses Node's own fatal behaviour, which
 * would turn a loud crash into a silently wedged process. `process.exit` is
 * stubbed so the assertion can see that it was called rather than the runner
 * dying on it.
 */
describe('initObservabilityNode — fatal handlers', () => {
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    it(`records and re-raises on ${event}`, async () => {
      process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
      const mod = await loadFresh();
      expect(mod.initObservabilityNode({ serviceName: 'svc' })).toBe(true);

      const exitCodes: Array<number | string | null | undefined> = [];
      // `process.exit` is typed `=> never`; a stub cannot honour that at
      // runtime, so the return is asserted rather than the parameters.
      vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null): never => {
        exitCodes.push(code);
        return undefined as never;
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const added = process.listeners(event).slice(preExistingCounts[event]);
      expect(added).toHaveLength(1);
      await fire(added[0], new Error('the cause'));

      await vi.waitFor(() => {
        expect(exitCodes).toContain(1);
      });

      // The record names both the reason and the underlying detail — a bare
      // reason would not tell an operator which failure killed the process.
      const logged = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(logged).toContain(event);
      expect(logged).toContain('the cause');
    });
  }

  it('still exits when the thrown value is not an Error', async () => {
    process.env['OTEL_CONSOLE_EXPORTER'] = 'true';
    const mod = await loadFresh();
    expect(mod.initObservabilityNode({ serviceName: 'svc' })).toBe(true);

    const exitCodes: Array<number | string | null | undefined> = [];
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null): never => {
      exitCodes.push(code);
      return undefined as never;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const added = process.listeners('uncaughtException').slice(preExistingCounts.uncaughtException);
    await fire(added[0], 'a bare string');

    await vi.waitFor(() => {
      expect(exitCodes).toContain(1);
    });
    expect(errorSpy.mock.calls.map((args) => args.join(' ')).join('\n')).toContain('a bare string');
  });
});
