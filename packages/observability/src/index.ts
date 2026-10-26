/**
 * @semiont/observability — public API.
 *
 * Universal surface (works in Node + browser). A Node process initializes
 * the SDK from `@semiont/observability/node` at its entry point; the Browser
 * initializes its own tracer (`apps/browser/src/lib/tracing.ts`). Everything
 * else uses this module.
 *
 * Traces and their propagation, and the one metric a client's transport
 * exports. The public surface:
 *
 *   - `withSpan(name, fn, options?)` — wrap an async block in a span;
 *     `options` carries `kind` and `attrs`.
 *   - `extractTraceparent(payload)` — W3C trace-context propagation across
 *     the SSE channel (a bus frame the gateway relays carries its trace in
 *     the payload field `TRACE_FIELD` names, from `@semiont/core`).
 *   - `withTraceparent(carrier, fn)` — run `fn` with the incoming
 *     traceparent as the parent context.
 *   - `withoutTrace(fn)` — run `fn` in no trace, so that what it starts
 *     begins a trace of its own.
 *   - `getActiveTraceparent()` — read the active span's traceparent, for
 *     an outbound request's `traceparent` header.
 *   - `recordBusSent(channel, scope?)` — count an emit a client sent.
 *   - `SpanKind`, re-exported from `@opentelemetry/api`. The type of the
 *     trace field, `TraceCarrier`, is `@semiont/core`'s.
 *
 * No-op when no exporter is configured: `@opentelemetry/api`'s default
 * tracer and meter are no-ops, so `withSpan` and the recorder are
 * essentially free until the process initializes an SDK.
 */

import {
  context,
  isSpanContextValid,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Span,
} from '@opentelemetry/api';
import { setBusLogTraceIdProvider, TRACE_FIELD, type TraceCarrier } from '@semiont/core';

// Wire `busLog`'s trace-id provider once at module load. When an OTel
// SDK is initialized (and a span is active when `busLog` fires), the
// emitted line gets a `trace=<8hex>` suffix that correlates the
// grep-timeline with the trace UI. No-op when no SDK is active.
setBusLogTraceIdProvider(() => {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return undefined;
  return ctx.traceId;
});

const TRACER_NAME = 'semiont';

const tracer = () => trace.getTracer(TRACER_NAME);

// ── withSpan ───────────────────────────────────────────────────────────

/**
 * Wrap an async block in a span. The span is started before `fn` runs and
 * ended after it resolves or rejects; exceptions are recorded and the span
 * status is set to ERROR. `kind` defaults to INTERNAL.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  options?: { kind?: SpanKind; attrs?: Attributes },
): Promise<T> {
  const span = tracer().startSpan(name, {
    kind: options?.kind ?? SpanKind.INTERNAL,
    ...(options?.attrs ? { attributes: options.attrs } : {}),
  });
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span));
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}

// ── Traceparent on bus payloads ────────────────────────────────────────

/**
 * Read the active span's W3C traceparent (and tracestate). Returns
 * `undefined` if no span is active.
 */
export function getActiveTraceparent(): TraceCarrier | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const traceparent = carrier['traceparent'];
  if (!traceparent) return undefined;
  return carrier['tracestate']
    ? { traceparent, tracestate: carrier['tracestate'] }
    : { traceparent };
}

/**
 * Strip and return the trace field (`TRACE_FIELD`) from a payload. Mutates `payload`.
 * The field is internal plumbing and should not be visible to subscribers.
 */
export function extractTraceparent<T extends Record<string, unknown>>(
  payload: T,
): TraceCarrier | undefined {
  const carrier = (payload as Record<string, unknown>)[TRACE_FIELD] as
    | TraceCarrier
    | undefined;
  if (carrier !== undefined) {
    delete (payload as Record<string, unknown>)[TRACE_FIELD];
  }
  if (!carrier || typeof carrier.traceparent !== 'string') return undefined;
  return carrier;
}

/**
 * Run `fn` with the given W3C traceparent set as the parent context.
 * Any spans started inside `fn` will be children of the incoming trace.
 * No-op if `carrier` is undefined.
 */
export function withTraceparent<T>(
  carrier: TraceCarrier | undefined,
  fn: () => T,
): T {
  if (!carrier) return fn();
  const carrierObj: Record<string, string> = { traceparent: carrier.traceparent };
  if (carrier.tracestate) carrierObj['tracestate'] = carrier.tracestate;
  const ctx = propagation.extract(context.active(), carrierObj);
  return context.with(ctx, fn);
}

/**
 * Run `fn` in no trace: a span started inside it, and every continuation it
 * registers, has no parent, whatever span is active where this is called. For
 * work that is nobody's: a worker's claim, which belongs to no job, is made
 * here even when the code that settled the job before it is inside that job's
 * span.
 */
export function withoutTrace<T>(fn: () => T): T {
  return context.with(ROOT_CONTEXT, fn);
}

// ── Metrics ────────────────────────────────────────────────────────────

const METER_NAME = 'semiont';

const meter = () => metrics.getMeter(METER_NAME);

let _busSentCounter: Counter | undefined;

function busSentCounter(): Counter {
  if (!_busSentCounter) {
    _busSentCounter = meter().createCounter('semiont.bus.sent', {
      description: 'Emits a client sent, by channel and scope',
    });
  }
  return _busSentCounter;
}

/**
 * Count an emit a client sent (`semiont.bus.sent`,
 * specs/src/sdk-telemetry/telemetry.json). Called at every transport `emit`
 * site. Its own name, apart from `semiont.bus.emit`, the gateway's count of
 * the emits it accepted.
 */
export function recordBusSent(channel: string, scope?: string): void {
  busSentCounter().add(1, {
    'bus.channel': channel,
    ...(scope ? { 'bus.scope': scope } : {}),
  });
}

// ── Re-export from @opentelemetry/api ──────────────────────────────────

export { SpanKind } from '@opentelemetry/api';
