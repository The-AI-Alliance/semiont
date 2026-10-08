# Observability API Reference

How to start telemetry in a process, and each helper with an example. What the package is for, and what a change to it must keep, is in its [README](../README.md).

## The three tiers

Semiont's observability is layered:

- **Tier 1 — `busLog`** (in [`@semiont/core`](../../core/README.md)): a 5-op grep-friendly timeline at the `ITransport` contract layer (`EMIT`, `RECV`, `SSE`, `PUT`, `GET`). Off until switched on (`SEMIONT_BUS_LOG=1` in Node, `window.__SEMIONT_BUS_LOG__ = true` in the browser); one property read per call while off.
- **Tier 2 — OpenTelemetry traces** (this package): spans, with W3C trace-context propagation across the bus's HTTP and SSE legs so a single user action produces one trace spanning Browser → gateway → worker → smelter.
- **Tier 3 — metrics and log correlation** (this package): counters, histograms and gauges for the platform's hot paths, and the active span's `trace_id` / `span_id` on every structured log line.

This package does not implement any platform domain logic; it provides the spanning helpers and metric recorders the rest of the codebase calls.

## Starting it in a Node process

Initialize once at the process entry point, before any spanning code runs:

```ts
// worker-main.ts (or smelter-main.ts, etc.)
import { initObservabilityNode } from '@semiont/observability/node';

initObservabilityNode({ serviceName: 'semiont-worker' });

// ...rest of process startup
```

Then use the universal API anywhere:

```ts
import { withSpan } from '@semiont/observability';

await withSpan('handle-request', async (span) => {
  span.setAttribute('user.id', userId);
  return await doWork();
});
```

What is exported, and where, is read from the standard `OTEL_*` variables. They are listed in [Observability](../../../docs/operator/administration/OBSERVABILITY.md).

## Process logger (Node)

For long-lived Node entry points (workers, smelter, the other sidecars), the package exposes a winston-based structured logger that auto-correlates each line with the active span:

```ts
// worker-main.ts (or smelter-main.ts, etc.)
import { createProcessLogger } from '@semiont/observability/process-logger';

const logger = createProcessLogger('worker');
logger.info('Started', { config });
```

Reads `LOG_LEVEL` (default `info`) and `LOG_FORMAT` (`json` default, `simple` for dev). When an OTel SDK is initialized and a span is active at log time, every emitted line gets `trace_id` / `span_id` fields — Tier 3 correlation between grep-the-stdout and the trace UI. Lives on its own subpath so consumers that don't want winston in their bundle can ignore it.

## In the browser

The universal API below runs in the Browser as it does in Node: the Browser bundles it through `@semiont/http-transport`, which is why `index.ts` imports no Node builtins. The Browser's tracer itself — the web SDK and its exporter — is the Browser's own (`apps/browser/src/lib/tracing.ts`), so no server that traces carries a browser SDK. Spans created in the SPA propagate to the gateway in the `traceparent` header of each bus emit; the gateway hands trace context back to subscribers in the `_trace` field of each SSE payload.

## Universal API

Everything below is from the main `@semiont/observability` import — works identically in Node and the browser.

### Spans

```ts
import { withSpan, withActorSpan, SpanKind } from '@semiont/observability';

// Generic async wrapper
await withSpan('parse-document', () => parser.parse(buf));

// With kind + attributes
await withSpan(
  `job:${job.type}`,
  () => runJob(job),
  { kind: SpanKind.CONSUMER, attrs: { 'job.id': job.id } },
);

// Actor handler wrapper — used at each actor's bus subscriptions to standardize
// span names across actors (Stower, Browser, Gatherer, Matcher, Smelter).
await withActorSpan('stower', 'mark:create-request', () => handler(payload));
```

### Trace-context propagation

Trace context crosses the bus in two forms. An outbound request (a bus emit, a content read or write) carries the active span in its W3C `traceparent` header, read with `getActiveTraceparent`. A frame the gateway relays over SSE has no headers of its own, so the gateway puts the context in the payload's `_trace` field: the receiver takes it off with `extractTraceparent` and runs its handlers under it with `withTraceparent`. `@semiont/http-transport` does both, so code that goes through a transport calls none of these:

```ts
import {
  extractTraceparent,
  withTraceparent,
  getActiveTraceparent,
  withSpan,
} from '@semiont/observability';

// Receiving: take `_trace` off the payload and continue its trace.
const carrier = extractTraceparent(incoming);
await withTraceparent(carrier, () =>
  withSpan('handle-incoming', () => process(incoming)),
);

// Sending: put the active span on the outbound request's headers.
const headers: Record<string, string> = {};
const trace = getActiveTraceparent();
if (trace) {
  headers['traceparent'] = trace.traceparent;
  if (trace.tracestate) headers['tracestate'] = trace.tracestate;
}
```

### Log correlation

Add the active trace-id and span-id to every log line so log search and the trace UI link up:

```ts
import { getLogTraceContext } from '@semiont/observability';

logger.info('job started', { ...getLogTraceContext() });
// → meta { trace_id: '4e3...', span_id: 'a1b...' } on the 'job started' line
```

### Metrics

The gateway and the dispatcher are Rust and emit their own metrics, the SSE subscriber count among them. The recorders here (Tier 3) cover the hot paths of the TypeScript services and transports:

```ts
import {
  recordBusSent,
  recordHandlerDuration,
  recordJobOutcome,
  recordInferenceUsage,
} from '@semiont/observability';

recordBusSent('mark:create-request', resourceId);  // channel, and the scope it was sent in
recordHandlerDuration('stower', 'mark:create-request', durationMs);
recordJobOutcome({ jobType: 'mark', motivation: 'linking' }, 'completed', durationMs);
recordInferenceUsage({ provider: 'ollama', model: 'gemma3:27b', durationMs, outcome: 'success', inputTokens: 412, outputTokens: 87 });
```

The recorders above are four of many. Each says what it measures where it is defined, in [`src/index.ts`](../src/index.ts).

### Provider registration

Long-lived snapshots (vector index size, the fact pump's backlog) are gauges, registered via callback so the SDK can pull at metric-export time:

```ts
import { registerVectorIndexSizeProvider } from '@semiont/observability';

registerVectorIndexSizeProvider(() => vectorStore.count());
```

## Implementation notes

This package wires `BasicTracerProvider` and `MeterProvider` (stable `@opentelemetry/sdk-trace-base` 2.x line) directly, plus `AsyncLocalStorageContextManager` for Node async-context propagation. It deliberately avoids `@opentelemetry/sdk-node` because that package's experimental 0.x versions cross-depend on older 2.0.x SDK lines, forcing npm to nest duplicate copies of the stable packages and bloating consumer bundles.

`initObservabilityNode` is idempotent — calling twice is a no-op and returns `false` on the second call. Both providers shut down cleanly on `SIGTERM` / `SIGINT`.
