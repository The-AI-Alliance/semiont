/**
 * @semiont/observability — public API.
 *
 * Universal surface (works in Node + browser). For SDK *initialization*,
 * import from `@semiont/observability/node` or `/web` at the process entry
 * point. Everything else uses this module.
 *
 * Tier 2 of `.plans/OBSERVABILITY.md`. The public surface is intentionally
 * thin:
 *
 *   - `withSpan(name, fn, attrs?)` — wrap an async block in a span.
 *   - `injectTraceparent(payload)` / `extractTraceparent(value)` — W3C
 *     trace-context propagation across the SSE channel (the bus payload
 *     gets a `_trace?: { traceparent }` sibling to `correlationId`).
 *   - `setSpanContextFromTraceparent(traceparent, fn)` — set incoming
 *     traceparent as the parent context for a synchronous block.
 *   - `getActiveTraceparent()` — read the active span's traceparent for
 *     manual propagation (e.g. attaching to a fetch header or SSE field).
 *
 * No-op when no exporter is configured: `@opentelemetry/api`'s default
 * tracer is a no-op, so `withSpan` is essentially free until
 * `initObservability*()` runs.
 */

import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';

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

const TRACE_FIELD = '_trace';

/**
 * Sibling of `correlationId` on bus payloads. Lives on the SSE event body
 * because SSE has no header trailer; the SDK strips it before delivering
 * the payload to subscribers. Additive — payloads without `_trace` parse
 * unchanged.
 */
export interface TraceCarrier {
  /** W3C `traceparent` header value (`00-<traceId>-<spanId>-<flags>`). */
  traceparent: string;
  /** W3C `tracestate` header value (vendor-specific extensions). */
  tracestate?: string;
}

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
 * Attach the active span's trace-context to a payload object as
 * `_trace`. No-op when no span is active. Returns the same object
 * reference for chaining.
 */
export function injectTraceparent<T extends Record<string, unknown>>(payload: T): T {
  const carrier = getActiveTraceparent();
  if (carrier) {
    (payload as Record<string, unknown>)[TRACE_FIELD] = carrier;
  }
  return payload;
}

/**
 * Strip and return the `_trace` field from a payload. Mutates `payload`.
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

// ── Actor handler convenience ──────────────────────────────────────────

/**
 * Wrap a bus-event handler in an `actor.<name>:<channel>` consumer span.
 * Used at every `eventBus.get(channel).subscribe(handler)` site inside
 * an actor (Stower, Gatherer, Matcher, Browser, Smelter), to attribute
 * each in-process subscriber's work to a span without scattering manual
 * `withSpan` calls across handler bodies.
 *
 * The span's parent is the active context at the time the handler
 * fires — which is the `bus.dispatch:<channel>` span on the backend
 * (Subject.next runs synchronously inside the dispatch span), or the
 * `bus.emit:<channel>` span when an actor emits to itself.
 */
export function withActorSpan<T>(
  actor: string,
  channel: string,
  fn: (span: Span) => Promise<T> | T,
  extraAttrs?: Attributes,
): Promise<T> {
  return withSpan(`actor.${actor}:${channel}`, fn, {
    kind: SpanKind.CONSUMER,
    attrs: {
      actor,
      'bus.channel': channel,
      ...(extraAttrs ?? {}),
    },
  });
}

// ── Re-exports from @opentelemetry/api ─────────────────────────────────

export { SpanKind, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
