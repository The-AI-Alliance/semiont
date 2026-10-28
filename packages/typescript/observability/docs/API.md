# Observability API Reference

How to start telemetry in a process, and each helper with an example. What the package is for, and what a change to it must keep, is in its [README](../README.md).

## The three tiers

Semiont's observability is layered:

- **Tier 1 — `busLog`** (in [`@semiont/core`](../../core/README.md)): a 5-op grep-friendly timeline at the `ITransport` contract layer (`EMIT`, `RECV`, `SSE`, `PUT`, `GET`). Off until switched on (`SEMIONT_BUS_LOG=1` in Node, `window.__SEMIONT_BUS_LOG__ = true` in the browser); one property read per call while off.
- **Tier 2 — OpenTelemetry traces** (this package): spans, with W3C trace-context propagation across the bus's HTTP and SSE legs so a single user action produces one trace spanning Browser → gateway → Librarian.
- **Tier 3 — metrics**: each service's own, and in this package the count of the emits a client sent.

This package does not implement any platform domain logic; it provides the spanning helpers and the recorder the TypeScript transport calls.

## Starting it in a Node process

Initialize once at the process entry point, before any spanning code runs:

```ts
// main.ts
import { initObservabilityNode } from '@semiont/observability/node';

initObservabilityNode({ serviceName: 'my-program' });

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

What is exported, and where, is read from the standard `OTEL_*` variables. They are listed in [Observability](../../../../docs/operator/administration/OBSERVABILITY.md).

## In the browser

The universal API below runs in the Browser as it does in Node: the Browser bundles it through `@semiont/http-transport`, which is why `index.ts` imports no Node builtins. The Browser's tracer itself — the web SDK and its exporter — is the Browser's own (`images/browser/src/lib/tracing.ts`), so no server that traces carries a browser SDK. Spans created in the SPA propagate to the gateway in the `traceparent` header of each bus emit; the gateway hands trace context back to subscribers in the trace field of each SSE payload.

## Universal API

Everything below is from the main `@semiont/observability` import — works identically in Node and the browser.

### Spans

```ts
import { withSpan, SpanKind } from '@semiont/observability';

// Generic async wrapper
await withSpan('parse-document', () => parser.parse(buf));

// With kind + attributes
await withSpan(
  `job:${job.type}`,
  () => runJob(job),
  { kind: SpanKind.CONSUMER, attrs: { 'job.id': job.id } },
);
```

### Trace-context propagation

Trace context crosses the bus in two forms. An outbound request (a bus emit, a content read or write) carries the active span in its W3C `traceparent` header, read with `getActiveTraceparent`. A frame the gateway relays over SSE has no headers of its own, so the gateway puts the context in the payload's trace field, which the bus registry names and `@semiont/core` exports as `TRACE_FIELD`: the receiver takes it off with `extractTraceparent` and runs its handlers under it with `withTraceparent`. `@semiont/http-transport` does both, so code that goes through a transport calls none of these:

```ts
import {
  extractTraceparent,
  withTraceparent,
  getActiveTraceparent,
  withSpan,
} from '@semiont/observability';

// Receiving: take the trace field off the payload and continue its trace.
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

Work that is nobody's to continue runs under `withoutTrace`: a span started inside it, and every continuation it registers, has no parent, whatever span is active where it is called. A worker's claim is made so, because it belongs to no job, and the code that settled the job before it is inside that job's span:

```ts
import { withoutTrace, withSpan } from '@semiont/observability';

await withSpan('job', async () => {
  // A child of `job`.
  await withSpan('work', () => doTheWork());
  // A trace of its own.
  withoutTrace(() => void claimTheNextJob());
});
```

### Metrics

Each service emits its own metrics: the gateway, the dispatcher and the Archivist are Rust, and the others are Python. The one recorder here is the transport's, `semiont.bus.sent`:

```ts
import { recordBusSent } from '@semiont/observability';

recordBusSent('mark:create-request', resourceId);  // channel, and the scope it was sent in
```

## Implementation notes

This package wires `TracerProvider` (from `@opentelemetry/sdk-trace`) and `MeterProvider` (from `@opentelemetry/sdk-metrics`) directly, plus `AsyncLocalStorageContextManager` for Node async-context propagation. `sdk-trace` reads no environment variable, so `initObservabilityNode` reads `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` itself, as the OpenTelemetry SDK configuration spec defines them. It does not use `@opentelemetry/sdk-node`, which would read every `OTEL_*` variable and brings the gRPC, protobuf, Zipkin and Prometheus exporters and the instrumentation framework, which this package does not use.

`initObservabilityNode` is idempotent — calling twice is a no-op and returns `false` on the second call. Both providers shut down cleanly on `SIGTERM` / `SIGINT`.
