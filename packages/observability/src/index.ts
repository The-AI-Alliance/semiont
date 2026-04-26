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
  isSpanContextValid,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type ObservableGauge,
  type Span,
  type UpDownCounter,
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
export async function withActorSpan<T>(
  actor: string,
  channel: string,
  fn: (span: Span) => Promise<T> | T,
  extraAttrs?: Attributes,
): Promise<T> {
  const start = performance.now();
  try {
    return await withSpan(`actor.${actor}:${channel}`, fn, {
      kind: SpanKind.CONSUMER,
      attrs: {
        actor,
        'bus.channel': channel,
        ...(extraAttrs ?? {}),
      },
    });
  } finally {
    recordHandlerDuration(actor, channel, performance.now() - start);
  }
}

// ── Log correlation ────────────────────────────────────────────────────

/**
 * Read the active span's `trace_id` / `span_id` for log-line correlation.
 * Tier 3 of `.plans/OBSERVABILITY.md`. Each structured log line gets
 * tagged with these so a log query in CloudWatch / Loki / Datadog can
 * jump to the trace in Tempo / Jaeger / X-Ray.
 *
 * Returns `undefined` if no span is active, or if the active span's
 * context is invalid (uninitialized SDK, no-op tracer).
 */
export function getLogTraceContext(): { trace_id: string; span_id: string } | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return undefined;
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

// ── Metrics — Tier 3 ───────────────────────────────────────────────────

const METER_NAME = 'semiont';

const meter = () => metrics.getMeter(METER_NAME);

let _busEmitCounter: Counter | undefined;
let _handlerDurationHistogram: Histogram | undefined;
let _jobOutcomeCounter: Counter | undefined;
let _jobDurationHistogram: Histogram | undefined;
let _inferenceCallsCounter: Counter | undefined;
let _inferenceTokensCounter: Counter | undefined;
let _inferenceDurationHistogram: Histogram | undefined;
let _sseSubscribers: UpDownCounter | undefined;
let _jobQueueGauge: ObservableGauge | undefined;
let _jobQueueProvider: (() => Promise<JobQueueSnapshot> | JobQueueSnapshot) | undefined;
let _vectorIndexSizeGauge: ObservableGauge | undefined;
let _vectorIndexSizeProvider: (() => Promise<number> | number) | undefined;

/** Snapshot of job-queue contents by status. Match `JobQueue.getStats()`. */
export interface JobQueueSnapshot {
  pending: number;
  running: number;
  complete: number;
  failed: number;
  cancelled: number;
}

function busEmitCounter(): Counter {
  if (!_busEmitCounter) {
    _busEmitCounter = meter().createCounter('semiont.bus.emit', {
      description: 'Bus emits by channel and scope',
    });
  }
  return _busEmitCounter;
}

function handlerDurationHistogram(): Histogram {
  if (!_handlerDurationHistogram) {
    _handlerDurationHistogram = meter().createHistogram('semiont.handler.duration', {
      description: 'In-process actor handler duration',
      unit: 'ms',
    });
  }
  return _handlerDurationHistogram;
}

function jobOutcomeCounter(): Counter {
  if (!_jobOutcomeCounter) {
    _jobOutcomeCounter = meter().createCounter('semiont.job.outcome', {
      description: 'Worker job completions by type and outcome',
    });
  }
  return _jobOutcomeCounter;
}

function jobDurationHistogram(): Histogram {
  if (!_jobDurationHistogram) {
    _jobDurationHistogram = meter().createHistogram('semiont.job.duration', {
      description: 'Worker job duration by type',
      unit: 'ms',
    });
  }
  return _jobDurationHistogram;
}

function inferenceCallsCounter(): Counter {
  if (!_inferenceCallsCounter) {
    _inferenceCallsCounter = meter().createCounter('semiont.inference.calls', {
      description: 'Inference API calls by provider, model, and outcome',
    });
  }
  return _inferenceCallsCounter;
}

function inferenceTokensCounter(): Counter {
  if (!_inferenceTokensCounter) {
    _inferenceTokensCounter = meter().createCounter('semiont.inference.tokens', {
      description: 'Inference token usage by provider, model, and direction',
    });
  }
  return _inferenceTokensCounter;
}

function inferenceDurationHistogram(): Histogram {
  if (!_inferenceDurationHistogram) {
    _inferenceDurationHistogram = meter().createHistogram('semiont.inference.duration', {
      description: 'Inference call duration by provider, model, and outcome',
      unit: 'ms',
    });
  }
  return _inferenceDurationHistogram;
}

function sseSubscribersCounter(): UpDownCounter {
  if (!_sseSubscribers) {
    _sseSubscribers = meter().createUpDownCounter('semiont.sse.subscribers', {
      description: 'Active SSE subscribers',
    });
  }
  return _sseSubscribers;
}

/** Increment the bus-emit counter. Called at every transport `emit` site. */
export function recordBusEmit(channel: string, scope?: string): void {
  busEmitCounter().add(1, {
    'bus.channel': channel,
    ...(scope ? { 'bus.scope': scope } : {}),
  });
}

/** Record an in-process actor handler's duration. */
export function recordHandlerDuration(actor: string, channel: string, durationMs: number): void {
  handlerDurationHistogram().record(durationMs, {
    actor,
    'bus.channel': channel,
  });
}

/** Record a worker job's outcome and duration. */
export function recordJobOutcome(jobType: string, outcome: 'completed' | 'failed', durationMs: number): void {
  jobOutcomeCounter().add(1, { 'job.type': jobType, 'job.outcome': outcome });
  jobDurationHistogram().record(durationMs, { 'job.type': jobType, 'job.outcome': outcome });
}

/** Increment the SSE subscriber gauge — call on `/bus/subscribe` open. */
export function recordSubscriberConnect(): void {
  sseSubscribersCounter().add(1);
}

/** Decrement on disconnect. Pair with `recordSubscriberConnect`. */
export function recordSubscriberDisconnect(): void {
  sseSubscribersCounter().add(-1);
}

/**
 * Register a callback that returns the current job-queue snapshot.
 * Polled at the SDK's metric-collection interval. The single gauge
 * emits one observation per status (`pending`, `running`, …) tagged
 * with the `job.status` attribute. Idempotent — last registered
 * provider wins.
 */
export function registerJobQueueProvider(
  provider: () => Promise<JobQueueSnapshot> | JobQueueSnapshot,
): void {
  _jobQueueProvider = provider;
  if (!_jobQueueGauge) {
    _jobQueueGauge = meter().createObservableGauge('semiont.job.queue.size', {
      description: 'Job queue size by status',
    });
    _jobQueueGauge.addCallback(async (observer) => {
      if (!_jobQueueProvider) return;
      const snap = await _jobQueueProvider();
      observer.observe(snap.pending, { 'job.status': 'pending' });
      observer.observe(snap.running, { 'job.status': 'running' });
      observer.observe(snap.complete, { 'job.status': 'complete' });
      observer.observe(snap.failed, { 'job.status': 'failed' });
      observer.observe(snap.cancelled, { 'job.status': 'cancelled' });
    });
  }
}

/**
 * Register a callback that returns the current vector-index size
 * (point count). Async to allow remote queries (Qdrant). Polled at
 * the metric-collection interval.
 */
export function registerVectorIndexSizeProvider(
  provider: () => Promise<number> | number,
): void {
  _vectorIndexSizeProvider = provider;
  if (!_vectorIndexSizeGauge) {
    _vectorIndexSizeGauge = meter().createObservableGauge('semiont.vector.index.size', {
      description: 'Vector store point count',
    });
    _vectorIndexSizeGauge.addCallback(async (observer) => {
      if (_vectorIndexSizeProvider) {
        const value = await _vectorIndexSizeProvider();
        observer.observe(value);
      }
    });
  }
}

/**
 * Record an inference call. Token counts are optional — providers that
 * don't expose them (or fail before generating) record only call count
 * and duration.
 */
export function recordInferenceUsage(opts: {
  provider: string;
  model: string;
  durationMs: number;
  outcome: 'success' | 'error';
  inputTokens?: number;
  outputTokens?: number;
}): void {
  const baseAttrs = {
    'inference.provider': opts.provider,
    'inference.model': opts.model,
    'inference.outcome': opts.outcome,
  };
  inferenceCallsCounter().add(1, baseAttrs);
  inferenceDurationHistogram().record(opts.durationMs, baseAttrs);
  if (opts.inputTokens != null && opts.inputTokens > 0) {
    inferenceTokensCounter().add(opts.inputTokens, {
      'inference.provider': opts.provider,
      'inference.model': opts.model,
      'inference.direction': 'input',
    });
  }
  if (opts.outputTokens != null && opts.outputTokens > 0) {
    inferenceTokensCounter().add(opts.outputTokens, {
      'inference.provider': opts.provider,
      'inference.model': opts.model,
      'inference.direction': 'output',
    });
  }
}

// ── Re-exports from @opentelemetry/api ─────────────────────────────────

export { SpanKind, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
