/**
 * Tests for the universal `@semiont/observability` surface.
 *
 * Wires a `BasicTracerProvider` + `InMemorySpanExporter` and a
 * `MeterProvider` + `InMemoryMetricExporter` for the duration of the
 * file so traces and metrics produced by `withSpan`, `withActorSpan`,
 * `recordBusEmit`, etc. are observable. Without an SDK installed the
 * `@opentelemetry/api` no-op tracer/meter takes over and these
 * functions still run safely — but assertions need real instruments
 * to inspect.
 *
 * The SDK install runs in `beforeAll`; teardown in `afterAll` resets the
 * globals so we don't bleed state into other test files (each Vitest
 * file runs in its own worker, but resetting is hygienic).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  context,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

import {
  extractTraceparent,
  getActiveTraceparent,
  getLogTraceContext,
  injectTraceparent,
  recordAbnormalTermination,
  recordAnchorOutcome,
  recordAppendStage,
  recordBusEmit,
  recordDetectionCall,
  recordGatherDegrade,
  recordGitCommand,
  recordGitStagingFailure,
  recordHandlerDuration,
  recordInferenceUsage,
  recordJobOutcome,
  recordReplySuppressed,
  recordResumeGap,
  recordSubscriberConnect,
  recordSubscriberDisconnect,
  recordUnanswerableRequest,
  materializeObservableGauges,
  registerCorrelationRegistryProvider,
  registerFactPumpDepthProvider,
  registerJobQueueProvider,
  registerProcessLifetimeMetrics,
  registerRestartCountProvider,
  registerVectorIndexSizeProvider,
  withActorSpan,
  withSpan,
  withTraceparent,
} from '../index';

const spanExporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
let metricReader: PeriodicExportingMetricReader;
let tracerProvider: BasicTracerProvider;
let meterProvider: MeterProvider;

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  // Short export interval keeps `flush()` fast in test loops.
  metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);
});

afterAll(async () => {
  await metricReader.shutdown();
  await meterProvider.shutdown();
  await tracerProvider.shutdown();
});

beforeEach(() => {
  spanExporter.reset();
  metricExporter.reset();
});

async function flushMetrics(): Promise<void> {
  await metricReader.forceFlush();
}

function findSpan(name: string): ReadableSpan | undefined {
  return spanExporter.getFinishedSpans().find((s) => s.name === name);
}

describe('withSpan', () => {
  it('wraps an async block, ends the span, and returns the result', async () => {
    const result = await withSpan('unit.work', async () => 42);
    expect(result).toBe(42);
    const span = findSpan('unit.work');
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records exception, sets ERROR status, and rethrows', async () => {
    const err = new Error('boom');
    await expect(withSpan('unit.fail', async () => { throw err; })).rejects.toBe(err);
    const span = findSpan('unit.fail');
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('boom');
    expect(span!.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('coerces non-Error throws to a string status message', async () => {
    await expect(
      withSpan('unit.fail-str', async () => { throw 'oops'; }),
    ).rejects.toBe('oops');
    const span = findSpan('unit.fail-str');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('oops');
  });

  it('honors options.kind and options.attrs', async () => {
    await withSpan('unit.kind', async () => undefined, {
      kind: SpanKind.SERVER,
      attrs: { 'unit.attr': 'val' },
    });
    const span = findSpan('unit.kind');
    expect(span).toBeDefined();
    expect(span!.kind).toBe(SpanKind.SERVER);
    expect(span!.attributes['unit.attr']).toBe('val');
  });

  it('runs synchronous fn correctly (still awaitable)', async () => {
    const result = await withSpan('unit.sync', () => 'sync-value');
    expect(result).toBe('sync-value');
    expect(findSpan('unit.sync')).toBeDefined();
  });
});

describe('getActiveTraceparent', () => {
  it('returns undefined outside a span', () => {
    expect(getActiveTraceparent()).toBeUndefined();
  });

  it('returns a W3C traceparent inside a span', async () => {
    let observed: ReturnType<typeof getActiveTraceparent>;
    await withSpan('unit.tp', async () => {
      observed = getActiveTraceparent();
    });
    expect(observed).toBeDefined();
    expect(observed!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });
});

describe('injectTraceparent / extractTraceparent', () => {
  it('injectTraceparent is a no-op outside a span', () => {
    const payload: Record<string, unknown> = { foo: 'bar' };
    const out = injectTraceparent(payload);
    expect(out).toBe(payload);
    expect(out['_trace']).toBeUndefined();
  });

  it('round-trips traceparent across inject/extract', async () => {
    let payload: Record<string, unknown> = {};
    await withSpan('unit.round-trip', async () => {
      payload = injectTraceparent({ correlationId: 'cid' });
    });

    expect(payload['_trace']).toBeDefined();
    expect((payload['_trace'] as { traceparent: string }).traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    );

    const carrier = extractTraceparent(payload);
    expect(carrier).toBeDefined();
    expect(carrier!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    // Payload is mutated to strip the field.
    expect(payload['_trace']).toBeUndefined();
  });

  it('extractTraceparent returns undefined when no `_trace` field is present', () => {
    expect(extractTraceparent({ correlationId: 'cid' })).toBeUndefined();
  });

  it('extractTraceparent returns undefined when `_trace` is malformed', () => {
    const payload: Record<string, unknown> = { _trace: { traceparent: 42 } };
    const carrier = extractTraceparent(payload);
    expect(carrier).toBeUndefined();
    // Malformed value still gets stripped.
    expect(payload['_trace']).toBeUndefined();
  });
});

describe('withTraceparent', () => {
  it('passes through to fn when carrier is undefined', () => {
    const result = withTraceparent(undefined, () => 'value');
    expect(result).toBe('value');
  });

  it('makes inner spans children of the supplied traceparent', async () => {
    // Synthesize a traceparent (24 zero-bytes for traceId, 8 for spanId).
    const traceId = '0123456789abcdef0123456789abcdef';
    const carrier = { traceparent: `00-${traceId}-1234567890abcdef-01` };

    let innerTraceId: string | undefined;
    await withTraceparent(carrier, async () => {
      await withSpan('unit.child', async () => {
        const tp = getActiveTraceparent();
        innerTraceId = tp?.traceparent.split('-')[1];
      });
    });

    expect(innerTraceId).toBe(traceId);
  });

  it('propagates tracestate when supplied', async () => {
    const carrier = {
      traceparent: '00-0123456789abcdef0123456789abcdef-1234567890abcdef-01',
      tracestate: 'vendor=value',
    };
    let observed: ReturnType<typeof getActiveTraceparent>;
    await withTraceparent(carrier, async () => {
      await withSpan('unit.ts', async () => {
        observed = getActiveTraceparent();
      });
    });
    expect(observed?.tracestate).toBe('vendor=value');
  });
});

describe('withActorSpan', () => {
  it('wraps fn in an actor.<name>:<channel> span with attributes', async () => {
    await withActorSpan('Stower', 'yield:create', async () => {
      // no-op
    });
    const span = findSpan('actor.Stower:yield:create');
    expect(span).toBeDefined();
    expect(span!.kind).toBe(SpanKind.CONSUMER);
    expect(span!.attributes['actor']).toBe('Stower');
    expect(span!.attributes['bus.channel']).toBe('yield:create');
  });

  it('forwards extra attributes onto the span', async () => {
    await withActorSpan('Gatherer', 'gather:requested', async () => {
      // no-op
    }, { resourceId: 'res-1' });
    const span = findSpan('actor.Gatherer:gather:requested');
    expect(span!.attributes['resourceId']).toBe('res-1');
  });

  it('rethrows after the underlying withSpan records the exception', async () => {
    const err = new Error('handler failed');
    await expect(
      withActorSpan('Smelter', 'job:claim', async () => { throw err; }),
    ).rejects.toBe(err);
    const span = findSpan('actor.Smelter:job:claim');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records handler duration on the histogram', async () => {
    await withActorSpan('Matcher', 'match:search-requested', async () => {
      // no-op
    });
    await flushMetrics();

    const metricsByName = collectMetrics();
    const handlerDuration = metricsByName.get('semiont.handler.duration');
    expect(handlerDuration).toBeDefined();
    // Histogram has at least one data point with the right tags.
    const dp = handlerDuration!.find((d) =>
      d.attributes['actor'] === 'Matcher' &&
      d.attributes['bus.channel'] === 'match:search-requested',
    );
    expect(dp).toBeDefined();
  });
});

describe('getLogTraceContext', () => {
  it('returns undefined outside a span', () => {
    expect(getLogTraceContext()).toBeUndefined();
  });

  it('returns trace_id and span_id inside a span', async () => {
    let observed: ReturnType<typeof getLogTraceContext>;
    await withSpan('unit.log-ctx', async () => {
      observed = getLogTraceContext();
    });
    expect(observed).toBeDefined();
    expect(observed!.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(observed!.span_id).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────

interface MetricDataPoint {
  attributes: Record<string, unknown>;
  value?: number;
  count?: number;
  sum?: number;
}

function collectMetrics(): Map<string, MetricDataPoint[]> {
  const out = new Map<string, MetricDataPoint[]>();
  for (const resourceMetric of metricExporter.getMetrics()) {
    for (const scopeMetric of resourceMetric.scopeMetrics) {
      for (const metric of scopeMetric.metrics) {
        const points: MetricDataPoint[] = metric.dataPoints.map((dp) => ({
          attributes: dp.attributes as Record<string, unknown>,
          value: typeof dp.value === 'number' ? dp.value : undefined,
          count: (dp.value as { count?: number })?.count,
          sum: (dp.value as { sum?: number })?.sum,
        }));
        const existing = out.get(metric.descriptor.name) ?? [];
        out.set(metric.descriptor.name, existing.concat(points));
      }
    }
  }
  return out;
}

describe('recordBusEmit', () => {
  it('increments the bus emit counter with channel + scope tags', async () => {
    recordBusEmit('mark:added', 'res-1');
    recordBusEmit('mark:added');
    await flushMetrics();

    const metricsByName = collectMetrics();
    const counter = metricsByName.get('semiont.bus.emit');
    expect(counter).toBeDefined();
    const withScope = counter!.find((d) => d.attributes['bus.scope'] === 'res-1');
    expect(withScope?.value).toBe(1);
    const withoutScope = counter!.find((d) => d.attributes['bus.scope'] === undefined);
    expect(withoutScope?.value).toBe(1);
  });
});

describe('recordHandlerDuration', () => {
  it('records on the handler duration histogram', async () => {
    recordHandlerDuration('Stower', 'yield:create', 42);
    await flushMetrics();

    const metricsByName = collectMetrics();
    const histogram = metricsByName.get('semiont.handler.duration');
    expect(histogram).toBeDefined();
    const dp = histogram!.find(
      (d) => d.attributes['actor'] === 'Stower' && d.attributes['bus.channel'] === 'yield:create',
    );
    expect(dp).toBeDefined();
    expect(dp!.count).toBeGreaterThanOrEqual(1);
  });
});

describe('recordJobOutcome', () => {
  it('writes to both the outcome counter and duration histogram', async () => {
    recordJobOutcome('mark.detect', 'completed', 1500);
    recordJobOutcome('mark.detect', 'failed', 800);
    await flushMetrics();

    const metricsByName = collectMetrics();
    const outcomes = metricsByName.get('semiont.job.outcome');
    expect(outcomes).toBeDefined();
    expect(outcomes!.length).toBeGreaterThanOrEqual(2);

    const completed = outcomes!.find((d) => d.attributes['job.outcome'] === 'completed');
    const failed = outcomes!.find((d) => d.attributes['job.outcome'] === 'failed');
    expect(completed?.value).toBe(1);
    expect(failed?.value).toBe(1);

    const durations = metricsByName.get('semiont.job.duration');
    expect(durations).toBeDefined();
    expect(durations!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('SSE subscriber up/down counter', () => {
  it('increments and decrements the gauge', async () => {
    recordSubscriberConnect();
    recordSubscriberConnect();
    recordSubscriberDisconnect();
    await flushMetrics();

    const metricsByName = collectMetrics();
    const counter = metricsByName.get('semiont.sse.subscribers');
    expect(counter).toBeDefined();
    // Net delta after +1 +1 -1 = +1 (cumulative aggregation).
    expect(counter![0]?.value).toBe(1);
  });
});

describe('registerJobQueueProvider', () => {
  it('registers a callback that emits one observation per status', async () => {
    registerJobQueueProvider(() => ({
      pending: 5,
      running: 2,
      complete: 100,
      failed: 1,
      cancelled: 0,
    }));
    await flushMetrics();

    const metricsByName = collectMetrics();
    const queue = metricsByName.get('semiont.job.queue.size');
    expect(queue).toBeDefined();
    const byStatus = new Map<string, number>(
      queue!.map((d) => [d.attributes['job.status'] as string, d.value!]),
    );
    expect(byStatus.get('pending')).toBe(5);
    expect(byStatus.get('running')).toBe(2);
    expect(byStatus.get('complete')).toBe(100);
    expect(byStatus.get('failed')).toBe(1);
    expect(byStatus.get('cancelled')).toBe(0);
  });

  it('honors the most recently registered provider', async () => {
    registerJobQueueProvider(() => ({
      pending: 1,
      running: 0,
      complete: 0,
      failed: 0,
      cancelled: 0,
    }));
    registerJobQueueProvider(() => ({
      pending: 99,
      running: 0,
      complete: 0,
      failed: 0,
      cancelled: 0,
    }));
    await flushMetrics();

    const metricsByName = collectMetrics();
    const queue = metricsByName.get('semiont.job.queue.size')!;
    const pending = queue.find((d) => d.attributes['job.status'] === 'pending');
    expect(pending?.value).toBe(99);
  });

  it('supports an async provider', async () => {
    registerJobQueueProvider(async () => ({
      pending: 7,
      running: 1,
      complete: 0,
      failed: 0,
      cancelled: 0,
    }));
    await flushMetrics();

    const metricsByName = collectMetrics();
    const queue = metricsByName.get('semiont.job.queue.size')!;
    const pending = queue.find((d) => d.attributes['job.status'] === 'pending');
    expect(pending?.value).toBe(7);
  });
});

describe('registerVectorIndexSizeProvider', () => {
  it('emits one observation per flush from the registered provider', async () => {
    registerVectorIndexSizeProvider(() => 12345);
    await flushMetrics();

    const metricsByName = collectMetrics();
    const gauge = metricsByName.get('semiont.vector.index.size');
    expect(gauge).toBeDefined();
    expect(gauge![0]?.value).toBe(12345);
  });

  it('supports an async provider', async () => {
    registerVectorIndexSizeProvider(async () => 999);
    await flushMetrics();

    const metricsByName = collectMetrics();
    const gauge = metricsByName.get('semiont.vector.index.size')!;
    expect(gauge[0]?.value).toBe(999);
  });
});

describe('registerRestartCountProvider', () => {
  // Order matters: cumulative aggregation re-exports a gauge's last observation
  // on every later flush, so the undefined case must run before any real one.
  it('skips the observation entirely when the provider returns undefined', async () => {
    registerRestartCountProvider(() => undefined);
    await flushMetrics();

    const metricsByName = collectMetrics();
    const gauge = metricsByName.get('semiont.process.restarts') ?? [];
    expect(gauge).toHaveLength(0);
  });

  it('observes 0 as a real reading — a healthy supervised process, not "unknown"', async () => {
    registerRestartCountProvider(() => 0);
    await flushMetrics();

    const metricsByName = collectMetrics();
    const gauge = metricsByName.get('semiont.process.restarts');
    expect(gauge).toBeDefined();
    expect(gauge![0]?.value).toBe(0);
  });

  it('supports an async provider', async () => {
    registerRestartCountProvider(async () => 3);
    await flushMetrics();

    const metricsByName = collectMetrics();
    const gauge = metricsByName.get('semiont.process.restarts')!;
    expect(gauge[0]?.value).toBe(3);
  });
});

describe('recordInferenceUsage', () => {
  it('records calls + duration on success without token counts', async () => {
    recordInferenceUsage({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      durationMs: 2500,
      outcome: 'success',
    });
    await flushMetrics();

    const metricsByName = collectMetrics();
    const calls = metricsByName.get('semiont.inference.calls');
    expect(calls).toBeDefined();
    const dp = calls!.find(
      (d) =>
        d.attributes['inference.provider'] === 'anthropic' &&
        d.attributes['inference.outcome'] === 'success',
    );
    expect(dp?.value).toBe(1);

    const durations = metricsByName.get('semiont.inference.duration');
    expect(durations).toBeDefined();
  });

  it('records token counts when present and skips zero / negative values', async () => {
    recordInferenceUsage({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      durationMs: 1500,
      outcome: 'success',
      inputTokens: 500,
      outputTokens: 250,
    });
    recordInferenceUsage({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      durationMs: 100,
      outcome: 'error',
      inputTokens: 0,
      outputTokens: 0,
    });
    await flushMetrics();

    const metricsByName = collectMetrics();
    const tokens = metricsByName.get('semiont.inference.tokens');
    expect(tokens).toBeDefined();
    const input = tokens!.find((d) => d.attributes['inference.direction'] === 'input');
    const output = tokens!.find((d) => d.attributes['inference.direction'] === 'output');
    expect(input?.value).toBe(500);
    expect(output?.value).toBe(250);
  });

  it('records error outcome on the calls counter', async () => {
    recordInferenceUsage({
      provider: 'openai',
      model: 'gpt-x',
      durationMs: 50,
      outcome: 'error',
    });
    await flushMetrics();

    const metricsByName = collectMetrics();
    const calls = metricsByName.get('semiont.inference.calls')!;
    const dp = calls.find(
      (d) =>
        d.attributes['inference.provider'] === 'openai' &&
        d.attributes['inference.outcome'] === 'error',
    );
    expect(dp?.value).toBe(1);
  });
});

describe('recordReplySuppressed', () => {
  it('counts a suppressed reply per channel', async () => {
    recordReplySuppressed('browse:resources');
    recordReplySuppressed('browse:resources');
    recordReplySuppressed('match:search');
    await flushMetrics();

    const counter = collectMetrics().get('semiont.bus.reply.suppressed');
    expect(counter).toBeDefined();
    expect(counter!.find((d) => d.attributes['bus.channel'] === 'browse:resources')?.value).toBe(2);
    expect(counter!.find((d) => d.attributes['bus.channel'] === 'match:search')?.value).toBe(1);
  });
});

describe('recordResumeGap', () => {
  it('counts a resume gap tagged by reason', async () => {
    recordResumeGap('cursor-expired');
    await flushMetrics();

    const counter = collectMetrics().get('semiont.bus.resume_gap');
    expect(counter).toBeDefined();
    expect(
      counter!.find((d) => d.attributes['bus.resume_gap.reason'] === 'cursor-expired')?.value,
    ).toBe(1);
  });
});

describe('recordUnanswerableRequest', () => {
  it('counts an unanswerable request per channel', async () => {
    recordUnanswerableRequest('gather:summary');
    await flushMetrics();

    const counter = collectMetrics().get('semiont.bus.unanswerable');
    expect(counter).toBeDefined();
    expect(counter!.find((d) => d.attributes['bus.channel'] === 'gather:summary')?.value).toBe(1);
  });
});

describe('registerCorrelationRegistryProvider', () => {
  it('observes claims and retained replies as separate series', async () => {
    registerCorrelationRegistryProvider(() => ({
      claims: 7,
      retainedReplies: 3,
      claimsMax: 4096,
      retainedRepliesMax: 1024,
    }));
    await flushMetrics();

    const gauge = collectMetrics().get('semiont.bus.correlation.size');
    expect(gauge).toBeDefined();
    const kind = (k: string) =>
      gauge!.find((d) => d.attributes['correlation.kind'] === k)?.value;
    expect(kind('claims')).toBe(7);
    expect(kind('retained_replies')).toBe(3);
    // The ceilings are series of their own so a reader never hard-codes them.
    expect(kind('claims_max')).toBe(4096);
    expect(kind('retained_replies_max')).toBe(1024);
  });

  it('last registered provider wins', async () => {
    const snap = (claims: number, retainedReplies: number) => ({
      claims,
      retainedReplies,
      claimsMax: 4096,
      retainedRepliesMax: 1024,
    });
    registerCorrelationRegistryProvider(() => snap(1, 1));
    registerCorrelationRegistryProvider(() => snap(42, 9));
    await flushMetrics();

    const gauge = collectMetrics().get('semiont.bus.correlation.size')!;
    expect(gauge.find((d) => d.attributes['correlation.kind'] === 'claims')?.value).toBe(42);
  });
});

describe('observable gauges registered before the SDK', () => {
  // The regression this exists for: the gateway registered its correlation
  // gauge at module scope, before initObservability*() installed a meter. The
  // metrics API hands out a no-op meter until then and never upgrades it, so
  // the gauge accepted its callback, reported success, and exported nothing
  // for the life of every gateway process. Order must not decide this.
  //
  // `semiont.process.start_time` is the one gauge no earlier test in this file
  // registers, so the parking path it exercises here is the real one rather
  // than a second registration against a gauge that already exists.
  it('park, survive the no-op meter, and export once the SDK comes up', async () => {
    metrics.disable(); // stand where a process boots: no meter provider at all

    // Registering here must be QUIET. A process with no exporter configured
    // has a no-op meter legitimately and forever — that is this package's
    // contract, and throwing would take down every deployment without an
    // OTLP endpoint.
    let threw: unknown;
    try {
      registerProcessLifetimeMetrics();
    } catch (err) {
      threw = err;
    }

    // Restore before asserting, so a failure here cannot strand the global
    // provider and take the rest of the file down with it.
    metrics.setGlobalMeterProvider(meterProvider);
    materializeObservableGauges();

    expect(threw, 'registering before init must not throw').toBeUndefined();

    await flushMetrics();
    const gauge = collectMetrics().get('semiont.process.start_time');
    expect(gauge?.[0]?.value, 'a gauge registered before init never exported').toBeGreaterThan(0);
  });
});

describe('recordAppendStage', () => {
  it('records a duration histogram per append stage', async () => {
    recordAppendStage('persist', 12);
    recordAppendStage('publish', 4);
    await flushMetrics();

    const hist = collectMetrics().get('semiont.record.append.duration');
    expect(hist).toBeDefined();
    const persist = hist!.find((d) => d.attributes['record.stage'] === 'persist');
    expect(persist?.count).toBe(1);
    expect(persist?.sum).toBe(12);
    expect(hist!.find((d) => d.attributes['record.stage'] === 'publish')?.sum).toBe(4);
  });
});

describe('recordGitCommand', () => {
  it('records a duration histogram per git command', async () => {
    recordGitCommand('commit', 30);
    recordGitCommand('commit', 10);
    await flushMetrics();

    const hist = collectMetrics().get('semiont.git.duration');
    expect(hist).toBeDefined();
    const commit = hist!.find((d) => d.attributes['git.command'] === 'commit');
    expect(commit?.count).toBe(2);
    expect(commit?.sum).toBe(40);
  });
});

describe('recordGatherDegrade', () => {
  it('counts a degraded gather per projection', async () => {
    recordGatherDegrade('graph');
    recordGatherDegrade('vectors');
    await flushMetrics();

    const counter = collectMetrics().get('semiont.gather.degraded');
    expect(counter).toBeDefined();
    expect(counter!.find((d) => d.attributes['projection'] === 'graph')?.value).toBe(1);
    expect(counter!.find((d) => d.attributes['projection'] === 'vectors')?.value).toBe(1);
  });
});

describe('recordGitStagingFailure', () => {
  it('counts an abandoned staging command by reason', async () => {
    recordGitStagingFailure('index-lock');
    recordGitStagingFailure('other');
    await flushMetrics();

    const counter = collectMetrics().get('semiont.git.staging.failures');
    expect(counter).toBeDefined();
    expect(counter!.find((d) => d.attributes['reason'] === 'index-lock')?.value).toBe(1);
    expect(counter!.find((d) => d.attributes['reason'] === 'other')?.value).toBe(1);
  });
});

describe('recordAnchorOutcome', () => {
  it('counts every anchoring, so degraded methods have a denominator', async () => {
    recordAnchorOutcome('Person', 'unique-match');
    recordAnchorOutcome('Person', 'unique-match');
    recordAnchorOutcome('Person', 'fuzzy-match');
    await flushMetrics();

    const counter = collectMetrics().get('semiont.detection.anchors');
    expect(counter).toBeDefined();
    const unique = counter!.find(
      (d) => d.attributes['detection.label'] === 'Person' && d.attributes['anchor.method'] === 'unique-match',
    );
    const fuzzy = counter!.find(
      (d) => d.attributes['detection.label'] === 'Person' && d.attributes['anchor.method'] === 'fuzzy-match',
    );
    expect(unique?.value).toBe(2);
    expect(fuzzy?.value).toBe(1);
  });
});

describe('recordDetectionCall', () => {
  const base = {
    label: 'Person',
    pieceChars: 4000,
    durationMs: 250,
    items: 3,
    depth: 0,
    reroll: false,
    outcome: 'success' as const,
  };

  it('records call count, duration, and item count under shared attributes', async () => {
    recordDetectionCall(base);
    await flushMetrics();

    const m = collectMetrics();
    const matches = (d: MetricDataPoint) =>
      d.attributes['detection.label'] === 'Person' &&
      d.attributes['detection.outcome'] === 'success' &&
      d.attributes['detection.depth'] === 0 &&
      d.attributes['detection.reroll'] === false;

    expect(m.get('semiont.detection.calls')!.find(matches)?.value).toBe(1);
    expect(m.get('semiont.detection.call.duration')!.find(matches)?.sum).toBe(250);
    expect(m.get('semiont.detection.call.items')!.find(matches)?.sum).toBe(3);
  });

  it('omits the token histogram when token counts are absent', async () => {
    recordDetectionCall(base);
    await flushMetrics();

    expect(collectMetrics().get('semiont.detection.call.tokens')).toBeUndefined();
  });

  it('splits token counts by direction when present', async () => {
    recordDetectionCall({ ...base, inputTokens: 900, outputTokens: 120 });
    await flushMetrics();

    const tokens = collectMetrics().get('semiont.detection.call.tokens');
    expect(tokens).toBeDefined();
    expect(tokens!.find((d) => d.attributes['detection.direction'] === 'input')?.sum).toBe(900);
    expect(tokens!.find((d) => d.attributes['detection.direction'] === 'output')?.sum).toBe(120);
  });

  it('carries reroll and non-success outcomes onto every instrument', async () => {
    recordDetectionCall({ ...base, reroll: true, depth: 2, outcome: 'truncated', items: 0 });
    await flushMetrics();

    const m = collectMetrics();
    const matches = (d: MetricDataPoint) =>
      d.attributes['detection.outcome'] === 'truncated' &&
      d.attributes['detection.reroll'] === true &&
      d.attributes['detection.depth'] === 2;

    expect(m.get('semiont.detection.calls')!.find(matches)?.value).toBe(1);
    expect(m.get('semiont.detection.call.items')!.find(matches)?.sum).toBe(0);
  });
});

describe('registerFactPumpDepthProvider', () => {
  it('observes the pump depth at collection time', async () => {
    let depth = 4;
    registerFactPumpDepthProvider(() => depth);
    await flushMetrics();

    expect(collectMetrics().get('semiont.archivist.fact_pump.depth')![0]?.value).toBe(4);

    // The gauge is pull-based: a later collection must see the new depth
    // without re-registering, which is the whole point of a provider.
    depth = 11;
    metricExporter.reset();
    await flushMetrics();
    expect(collectMetrics().get('semiont.archivist.fact_pump.depth')![0]?.value).toBe(11);
  });

  it('observes zero rather than skipping — zero at rest is the healthy reading', async () => {
    registerFactPumpDepthProvider(() => 0);
    await flushMetrics();

    expect(collectMetrics().get('semiont.archivist.fact_pump.depth')![0]?.value).toBe(0);
  });
});

describe('recordAbnormalTermination', () => {
  it('counts the termination by reason', async () => {
    recordAbnormalTermination('uncaughtException', 'boom');
    await flushMetrics();

    const counter = collectMetrics().get('semiont.process.abnormal_exit');
    expect(counter).toBeDefined();
    expect(counter!.find((d) => d.attributes['reason'] === 'uncaughtException')?.value).toBe(1);
  });

  it('marks the active span as ended-in-death rather than leaving it unended', async () => {
    await withSpan('unit.dying', async () => {
      recordAbnormalTermination('unhandledRejection', 'promise blew up');
    });

    const span = findSpan('unit.dying');
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('unhandledRejection: promise blew up');
    expect(span!.attributes['semiont.process.abnormal_exit']).toBe('unhandledRejection');
    expect(span!.ended).toBe(true);
  });

  it('omits the separator entirely when no detail is given', async () => {
    await withSpan('unit.dying-bare', async () => {
      recordAbnormalTermination('uncaughtException');
    });

    expect(findSpan('unit.dying-bare')!.status.message).toBe('uncaughtException');
  });

  it('treats a blank detail as no detail', async () => {
    await withSpan('unit.dying-blank', async () => {
      recordAbnormalTermination('uncaughtException', '   ');
    });

    expect(findSpan('unit.dying-blank')!.status.message).toBe('uncaughtException');
  });

  it('is safe with no active span', async () => {
    expect(() => recordAbnormalTermination('uncaughtException', 'no span here')).not.toThrow();
  });
});
