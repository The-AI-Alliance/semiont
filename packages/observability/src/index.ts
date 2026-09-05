/**
 * @semiont/observability — public API.
 *
 * Universal surface (works in Node + browser). For SDK *initialization*,
 * import from `@semiont/observability/node` or `/web` at the process entry
 * point. Everything else uses this module.
 *
 * Tier 2 of `.plans/OBSERVABILITY.md`. The public surface:
 *
 *   - `withSpan(name, fn, options?)` — wrap an async block in a span;
 *     `options` carries `kind` and `attrs`.
 *   - `withActorSpan(actor, channel, fn, extraAttrs?)` — consumer-span
 *     wrapper for bus-event handlers, with handler-duration recording.
 *   - `injectTraceparent(payload)` / `extractTraceparent(payload)` — W3C
 *     trace-context propagation across the SSE channel (the bus payload
 *     gets a `_trace?: { traceparent }` sibling to `correlationId`).
 *   - `withTraceparent(carrier, fn)` — run `fn` with the incoming
 *     traceparent as the parent context.
 *   - `getActiveTraceparent()` — read the active span's traceparent for
 *     manual propagation (e.g. attaching to a fetch header or SSE field).
 *   - `getLogTraceContext()` — active `trace_id` / `span_id` for log-line
 *     correlation.
 *   - Metric recorders (`recordBusEmit`, `recordHandlerDuration`,
 *     `recordJobOutcome`, `recordSubscriberConnect` / `Disconnect`,
 *     `recordInferenceUsage`) and gauge providers
 *     (`registerJobQueueProvider`, `registerVectorIndexSizeProvider`).
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
import { setBusLogTraceIdProvider } from '@semiont/core';

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
 * fires — which is the `bus.dispatch:<channel>` span on the gateway
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
let _replySuppressedCounter: Counter | undefined;
let _resumeGapCounter: Counter | undefined;
let _unanswerableCounter: Counter | undefined;
let _correlationRegistryGauge: ObservableGauge | undefined;
let _correlationRegistryProvider: (() => CorrelationRegistrySnapshot) | undefined;
let _handlerDurationHistogram: Histogram | undefined;
let _jobOutcomeCounter: Counter | undefined;
let _jobDurationHistogram: Histogram | undefined;
let _gatherDegradeCounter: Counter | undefined;
let _inferenceCallsCounter: Counter | undefined;
let _inferenceTokensCounter: Counter | undefined;
let _inferenceDurationHistogram: Histogram | undefined;
let _sseSubscribers: UpDownCounter | undefined;
let _jobQueueGauge: ObservableGauge | undefined;
let _jobQueueProvider: (() => Promise<JobQueueSnapshot> | JobQueueSnapshot) | undefined;
let _vectorIndexSizeGauge: ObservableGauge | undefined;
let _factPumpDepthGauge: ObservableGauge | undefined;
let _factPumpDepthProvider: (() => number) | undefined;
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

function replySuppressedCounter(): Counter {
  if (!_replySuppressedCounter) {
    _replySuppressedCounter = meter().createCounter('semiont.bus.reply.suppressed', {
      description: 'Correlated replies withheld from a non-owning subscriber',
    });
  }
  return _replySuppressedCounter;
}

/**
 * A correlated reply was withheld from a subscriber that does not own its
 * correlationId (CORRELATED-REPLY-ROUTING P5).
 *
 * Counts ONLY that case. A frame with no correlationId is a shape violation
 * (warned, not counted), and a cid nobody claimed is the structural in-process
 * case that fires constantly — counting either would drown the signal this
 * metric exists to show: the fan-out amplification the delivery filter removes.
 */
export function recordReplySuppressed(channel: string): void {
  replySuppressedCounter().add(1, { 'bus.channel': channel });
}

function resumeGapCounter(): Counter {
  if (!_resumeGapCounter) {
    _resumeGapCounter = meter().createCounter('semiont.bus.resume_gap', {
      description: 'SSE resumes that degraded to a gap because replay was unavailable',
    });
  }
  return _resumeGapCounter;
}

/**
 * An SSE resume could not be served and the client was told to fall back to
 * cache. This degradation is CORRECT by design and therefore silent — which is
 * exactly why it needs a number. A rising rate means clients are losing
 * history, and nothing else in the stack says so.
 */
export function recordResumeGap(reason: string): void {
  resumeGapCounter().add(1, { 'bus.resume_gap.reason': reason });
}

function unanswerableCounter(): Counter {
  if (!_unanswerableCounter) {
    _unanswerableCounter = meter().createCounter('semiont.bus.unanswerable', {
      description: 'Request emits that reached zero subscribers and were failed at the gateway',
    });
  }
  return _unanswerableCounter;
}

/**
 * A request-shaped emit reached no subscriber, so the gateway synthesized its
 * mapped failure (ARCHIVIST-STAYS-UP P3). By channel, this is the absence rate
 * of the service that answers it — the difference between "it went down once"
 * and "it is flapping."
 */
export function recordUnanswerableRequest(channel: string): void {
  unanswerableCounter().add(1, { 'bus.channel': channel });
}

/** Claims held and reply payloads retained by a gateway's correlation registry. */
export interface CorrelationRegistrySnapshot {
  claims: number;
  retainedReplies: number;
}

/**
 * Register a callback returning the gateway's correlation-registry occupancy.
 *
 * COUNTS, not bytes: retention is count-budgeted today (byte-budgeting is a
 * known limit in CORRELATED-REPLY-ROUTING), so `retainedReplies` is a proxy for
 * heap, not a measure of it. It is still the closest observable to the question
 * two OOM investigations keep asking — a browse result can be 1-2 MB, and up to
 * REPLY_RETENTION_MAX of them are held at once.
 */
export function registerCorrelationRegistryProvider(
  provider: () => CorrelationRegistrySnapshot,
): void {
  _correlationRegistryProvider = provider;
  if (!_correlationRegistryGauge) {
    _correlationRegistryGauge = meter().createObservableGauge('semiont.bus.correlation.size', {
      description: 'Correlation registry occupancy: live claims and retained reply payloads',
    });
    _correlationRegistryGauge.addCallback((observer) => {
      if (!_correlationRegistryProvider) return;
      const snap = _correlationRegistryProvider();
      observer.observe(snap.claims, { 'correlation.kind': 'claims' });
      observer.observe(snap.retainedReplies, { 'correlation.kind': 'retained_replies' });
    });
  }
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

let _appendStageHistogram: Histogram | undefined;
function appendStageHistogram(): Histogram {
  if (!_appendStageHistogram) {
    _appendStageHistogram = meter().createHistogram('semiont.record.append.duration', {
      description: 'Time spent in one stage of appending an event to the record, labeled by stage: persist (JSONL write + git), materialize (view rebuild), enrich, publish. The Archivist\'s core write path.',
      unit: 'ms',
    });
  }
  return _appendStageHistogram;
}

/**
 * Record one stage of `EventStore.appendEvent` (ARCHIVIST-STAYS-UP P7).
 *
 * The append path is the one operation only the Archivist can perform, and it
 * was entirely dark: reads had `recordHandlerDuration` and the bus had its own
 * counters, while writes had nothing. Stage-labeled because the useful
 * question is never "was the append slow" but WHICH PART — and `materialize`
 * in particular does work proportional to a resource's annotation count, so it
 * degrades with history rather than with load.
 */
export function recordAppendStage(
  stage: 'persist' | 'materialize' | 'enrich' | 'publish',
  durationMs: number,
): void {
  appendStageHistogram().record(durationMs, { 'record.stage': stage });
}

let _gitCommandHistogram: Histogram | undefined;
function gitCommandHistogram(): Histogram {
  if (!_gitCommandHistogram) {
    _gitCommandHistogram = meter().createHistogram('semiont.git.duration', {
      description: 'Time spent in a synchronous git subprocess. These run on the event loop, so this duration is also time no other request could be served.',
      unit: 'ms',
    });
  }
  return _gitCommandHistogram;
}

/**
 * Record a synchronous git invocation (ARCHIVIST-STAYS-UP P7).
 *
 * These are `execFileSync`, so **the duration is event-loop blockage, not just
 * latency** — every concurrent `browse:*` read waits behind it. One `git add`
 * runs per appended event, so a detection job writing hundreds of annotations
 * spawns hundreds of blocking subprocesses. That is the suspected mechanism
 * behind "reads serializing behind the detection job's annotation writes" in
 * `bugs/absent-archivist-wedges-browse.md`, which recorded the symptom without
 * a cause. This number is what turns that from a hypothesis into a reading.
 */
export function recordGitCommand(command: string, durationMs: number): void {
  gitCommandHistogram().record(durationMs, { 'git.command': command });
}

function gatherDegradeCounter(): Counter {
  if (!_gatherDegradeCounter) {
    _gatherDegradeCounter = meter().createCounter('semiont.gather.degraded', {
      description: 'Gathers that degraded because an eventually-consistent projection did not catch up within its read barrier (vectors: absent semanticContext; graph: projection-lag failure). Labeled by projection.',
    });
  }
  return _gatherDegradeCounter;
}

/**
 * Record a gather degraded by a projection read barrier: `'vectors'` — the
 * Smelter settle barrier timed out (semanticContext shipped absent);
 * `'graph'` — the Weaver applied barrier + poll floor exhausted (projection
 * lag surfaced as a distinct failure). Fleet-alertable counterpart of the
 * `[gather DEGRADED]` L4 breadcrumbs — a rising rate on either label means
 * that pipeline is not keeping up.
 */
export function recordGatherDegrade(projection: 'graph' | 'vectors'): void {
  gatherDegradeCounter().add(1, { projection });
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
/**
 * Register the Archivist's fact-pump backlog — facts appended to the record
 * but not yet republished onto the bus.
 *
 * At rest this is zero. A value that climbs and does not come back means the
 * pump is outrunning its transport, which is the leading hypothesis for the
 * load-correlated heap growth in `bugs/absent-archivist-wedges-browse.md`
 * (ARCHIVIST-STAYS-UP P5). The backlog is deliberately unbounded today, so
 * this number is the only thing standing between "the pump is behind" and an
 * OOM whose cause is inferred from RSS after the fact.
 */
export function registerFactPumpDepthProvider(provider: () => number): void {
  _factPumpDepthProvider = provider;
  if (!_factPumpDepthGauge) {
    _factPumpDepthGauge = meter().createObservableGauge('semiont.archivist.fact_pump.depth', {
      description: 'Facts appended to the record but not yet published to the bus. Zero at rest; a rising floor means the pump is behind its transport.',
    });
    _factPumpDepthGauge.addCallback((observer) => {
      if (_factPumpDepthProvider) observer.observe(_factPumpDepthProvider());
    });
  }
}

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

let _detectionCallCounter: Counter | undefined;
let _detectionDurationHistogram: Histogram | undefined;
let _detectionItemsHistogram: Histogram | undefined;
let _detectionTokensHistogram: Histogram | undefined;

function detectionCallCounter(): Counter {
  if (!_detectionCallCounter) {
    _detectionCallCounter = meter().createCounter('semiont.detection.calls', {
      description: 'Detection model calls, labeled by motivation, outcome, subdivision depth and whether this was the floor re-roll.',
    });
  }
  return _detectionCallCounter;
}

function detectionDurationHistogram(): Histogram {
  if (!_detectionDurationHistogram) {
    _detectionDurationHistogram = meter().createHistogram('semiont.detection.call.duration', {
      description: 'Wall time of one detection model call, including the attempts that failed and were retried smaller.',
      unit: 'ms',
    });
  }
  return _detectionDurationHistogram;
}

function detectionItemsHistogram(): Histogram {
  if (!_detectionItemsHistogram) {
    _detectionItemsHistogram = meter().createHistogram('semiont.detection.call.items', {
      description: 'Annotations returned by one detection call. Against the input size on the same record, this is yield.',
    });
  }
  return _detectionItemsHistogram;
}

function detectionTokensHistogram(): Histogram {
  if (!_detectionTokensHistogram) {
    _detectionTokensHistogram = meter().createHistogram('semiont.detection.call.tokens', {
      description: "Provider-reported tokens for one detection call, by direction. Deliberately separate from semiont.inference.tokens: that series is the authoritative total but carries no subdivision depth, and 'what does a depth-2 call cost' is the question every sizing decision asks.",
    });
  }
  return _detectionTokensHistogram;
}

/**
 * Record one detection model call (DETECTION-QUALITY-THROUGHPUT P1).
 *
 * The adapters already record provider/model/duration/tokens for every
 * inference call. What they cannot know is the detection shape around it:
 * which motivation asked, how big the piece was, how many annotations came
 * back, how deep subdivision had descended, and whether this was the floor
 * re-roll. Those are the facts that distinguish a healthy call from a
 * expensive descent, and without them a slow detection run is one
 * undifferentiated number.
 *
 * FAILED attempts are recorded too, and that is the point: the calls paid for
 * and thrown away during a descent are exactly the cost later phases exist to
 * avoid, so a record only of successes would hide the thing being optimized.
 *
 * Tokens are the PROVIDER's counts, passed through — never estimated. Absent
 * means the provider did not report them.
 */
export function recordDetectionCall(opts: {
  label: string;
  pieceChars: number;
  durationMs: number;
  items: number;
  depth: number;
  reroll: boolean;
  outcome: 'success' | 'truncated' | 'timeout' | 'collapsed' | 'error';
  inputTokens?: number;
  outputTokens?: number;
}): void {
  const attrs = {
    'detection.label': opts.label,
    'detection.outcome': opts.outcome,
    'detection.depth': opts.depth,
    'detection.reroll': opts.reroll,
  };
  detectionCallCounter().add(1, attrs);
  detectionDurationHistogram().record(opts.durationMs, attrs);
  detectionItemsHistogram().record(opts.items, attrs);
  if (opts.inputTokens !== undefined) {
    detectionTokensHistogram().record(opts.inputTokens, { ...attrs, 'detection.direction': 'input' });
  }
  if (opts.outputTokens !== undefined) {
    detectionTokensHistogram().record(opts.outputTokens, { ...attrs, 'detection.direction': 'output' });
  }
}

let _anchorOutcomeCounter: Counter | undefined;
function anchorOutcomeCounter(): Counter {
  if (!_anchorOutcomeCounter) {
    _anchorOutcomeCounter = meter().createCounter('semiont.detection.anchors', {
      description: 'Every annotation anchoring, labeled by the method that resolved it. EVERY outcome is counted, not just the risky ones, because a bare count of degraded anchors has no denominator — the rate is the precision signal.',
    });
  }
  return _anchorOutcomeCounter;
}

/**
 * Record how one annotation got anchored (DETECTION-QUALITY-THROUGHPUT P5).
 *
 * The selector-vs-source check is already a WRITE-TIME INVARIANT — both
 * `buildTextAnnotation` and `buildPdfAnnotation` throw on a selector that does
 * not match its source — so mechanical correctness is guaranteed rather than
 * sampled, and auditing it would measure a constant.
 *
 * What is genuinely uncertain is which anchoring METHOD got there. An `exact`
 * the model quoted verbatim and that appears once is certain; one resolved by
 * `first-of-many` (several occurrences, no usable context) or `fuzzy-match`
 * picked a plausible occurrence and may have picked wrong. Those were visible
 * only as log warnings — countable by a human reading worker output, which is
 * how 47 of them went unreviewed. As a rate they are the precision number that
 * sits beside the yield numbers.
 */
export function recordAnchorOutcome(label: string, method: string): void {
  anchorOutcomeCounter().add(1, { 'detection.label': label, 'anchor.method': method });
}

// ── Re-exports from @opentelemetry/api ─────────────────────────────────

export { SpanKind, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
