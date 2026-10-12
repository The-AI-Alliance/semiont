/**
 * Tests for the universal `@semiont/observability` surface.
 *
 * Wires a `BasicTracerProvider` + `InMemorySpanExporter` and a
 * `MeterProvider` + `InMemoryMetricExporter` for the duration of the
 * file so traces and metrics produced by `withSpan`, `recordBusSent`,
 * etc. are observable. Without an SDK installed the
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
  recordBusSent,
  withSpan,
  withTraceparent,
  withoutTrace,
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

describe('extractTraceparent', () => {
  it('returns the carrier and strips the field from the payload', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const payload: Record<string, unknown> = { foo: 'bar', _trace: { traceparent } };

    const carrier = extractTraceparent(payload);

    expect(carrier).toEqual({ traceparent });
    expect(payload).toEqual({ foo: 'bar' });
  });

  it('returns undefined when no `_trace` field is present', () => {
    expect(extractTraceparent({ foo: 'bar' })).toBeUndefined();
  });

  it('returns undefined when `_trace` is malformed', () => {
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

describe('withoutTrace', () => {
  it('returns what fn returns', () => {
    expect(withoutTrace(() => 'value')).toBe('value');
  });

  it('runs fn under no span, inside a span', async () => {
    let outside: ReturnType<typeof getActiveTraceparent>;
    let within: ReturnType<typeof getActiveTraceparent>;
    await withSpan('unit.outer', () => {
      outside = getActiveTraceparent();
      within = withoutTrace(() => getActiveTraceparent());
    });

    expect(outside).toBeDefined();
    expect(within).toBeUndefined();
  });

  it('begins a trace of its own for a span started inside it, and for what that span awaits', async () => {
    let outer: string | undefined;
    let inner: string | undefined;
    let continued: string | undefined;
    await withSpan('unit.outer', async () => {
      outer = getActiveTraceparent()?.traceparent.split('-')[1];
      await withoutTrace(() =>
        withSpan('unit.apart', async () => {
          inner = getActiveTraceparent()?.traceparent.split('-')[1];
          await Promise.resolve();
          continued = getActiveTraceparent()?.traceparent.split('-')[1];
        }),
      );
    });

    expect(inner).toBeDefined();
    expect(inner).not.toBe(outer);
    expect(continued).toBe(inner);
    const apart = findSpan('unit.apart');
    expect(apart).toBeDefined();
    expect(apart?.parentSpanContext).toBeUndefined();
  });

  it('leaves the span it was called in active once it returns', async () => {
    let before: string | undefined;
    let after: string | undefined;
    await withSpan('unit.outer', () => {
      before = getActiveTraceparent()?.traceparent;
      withoutTrace(() => undefined);
      after = getActiveTraceparent()?.traceparent;
    });

    expect(after).toBe(before);
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

describe('recordBusSent', () => {
  it('counts an emit a client sent, by channel and scope, under a name of its own', async () => {
    recordBusSent('mark:added', 'res-1');
    recordBusSent('mark:added');
    await flushMetrics();

    const metricsByName = collectMetrics();
    // Not `semiont.bus.emit`: that is the gateway's count of what it accepted.
    expect(metricsByName.has('semiont.bus.emit')).toBe(false);
    const counter = metricsByName.get('semiont.bus.sent');
    expect(counter).toBeDefined();
    const withScope = counter!.find((d) => d.attributes['bus.scope'] === 'res-1');
    expect(withScope?.value).toBe(1);
    const withoutScope = counter!.find((d) => d.attributes['bus.scope'] === undefined);
    expect(withoutScope?.value).toBe(1);
  });
});
