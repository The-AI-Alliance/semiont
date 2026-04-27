# @semiont/observability

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+observability%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=observability)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=observability)
[![npm version](https://img.shields.io/npm/v/@semiont/observability.svg)](https://www.npmjs.com/package/@semiont/observability)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/observability.svg)](https://www.npmjs.com/package/@semiont/observability)
[![License](https://img.shields.io/npm/l/@semiont/observability.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

OpenTelemetry-based tracing and metrics for [Semiont](https://github.com/The-AI-Alliance/semiont). Tier 2 of the Semiont observability stack: process-init helpers (Node + Web), a thin `withSpan` wrapper, W3C trace-context propagation across the bus, and a small set of metric recorders for the platform's hot paths.

> **Off by default.** With no `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_CONSOLE_EXPORTER=true`) set, every API in this package becomes a no-op via the `@opentelemetry/api` no-op tracer. You pay nothing in production unless you opt in.

## Architecture context

Semiont's observability is layered:

- **Tier 1 — `busLog`** (in [`@semiont/core`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/core)): a 5-op grep-friendly timeline at the `ITransport` contract layer (`EMIT`, `RECV`, `SSE`, `PUT`, `GET`). Always on, always free.
- **Tier 2 — this package**: real OpenTelemetry traces + metrics, with W3C trace-context propagation across the bus's HTTP and SSE legs so a single user action produces one trace spanning frontend → backend → worker → smelter.
- **Tier 3** — log correlation and dashboards.

This package does not implement any platform domain logic; it provides the spanning helpers and metric recorders the rest of the codebase calls.

## Installation

```bash
npm install @semiont/observability
```

## Quick start (Node)

Initialize once at the process entry point, before any spanning code runs:

```ts
// worker-main.ts (or backend index.ts, etc.)
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

Configuration is via the standard `OTEL_*` env vars:

| Variable | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector HTTP endpoint (e.g. `http://jaeger:4318`) |
| `OTEL_SERVICE_NAME` | Overrides the `serviceName` passed to `init` |
| `OTEL_TRACES_SAMPLER` | Sampler (default: `parentbased_always_on`) |
| `OTEL_TRACES_SAMPLER_ARG` | Sampler ratio (default: `1.0`) |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval ms (default: 30000) |
| `OTEL_CONSOLE_EXPORTER=true` | Dev-only: emit spans + metrics to stderr |
| `OTEL_SDK_DISABLED=true` | Skip initialization entirely |

## Quick start (Web)

```ts
// SPA entry point (main.tsx)
import { initObservabilityWeb } from '@semiont/observability/web';

initObservabilityWeb({ serviceName: 'semiont-frontend' });
```

Web init wires up the same universal API plus browser-appropriate context propagation. Spans created in the SPA propagate to the backend via the bus's `_trace` payload field.

## Universal API

Everything below is from the main `@semiont/observability` import — works identically in Node and the browser.

### Spans

```ts
import { withSpan, withActorSpan, SpanKind } from '@semiont/observability';

// Generic async wrapper
await withSpan('parse-document', () => parser.parse(buf));

// With kind + attributes
await withSpan(
  'job:reference-annotation',
  () => runJob(job),
  { kind: SpanKind.CONSUMER, attrs: { 'job.id': job.id } },
);

// Actor handler wrapper — used by the bus dispatcher to standardize
// span names across StowerVM, BrowserVM, GathererVM, MatcherVM, SmelterVM.
await withActorSpan('stower', 'mark:create', () => handler(payload));
```

### Trace-context propagation

W3C `traceparent` propagation is automatic for HTTP requests routed through the bus. For payloads that cross SSE (or any non-HTTP channel), use the explicit helpers:

```ts
import {
  injectTraceparent,
  extractTraceparent,
  withTraceparent,
  getActiveTraceparent,
} from '@semiont/observability';

// Sender side: stamp the active trace onto the bus payload.
const wirePayload = injectTraceparent(payload);

// Receiver side: extract and continue the trace.
const traceparent = extractTraceparent(incoming);
await withTraceparent(traceparent, () =>
  withSpan('handle-incoming', () => process(incoming)),
);
```

### Log correlation

Add the active trace-id and span-id to every log line so log search and the trace UI link up:

```ts
import { getLogTraceContext } from '@semiont/observability';

logger.info({ ...getLogTraceContext(), msg: 'job started' });
// → { trace_id: '4e3...', span_id: 'a1b...', msg: 'job started' }
```

### Metrics

Hot-path metric recorders. The names and label conventions are picked to match Tier 3 dashboards:

```ts
import {
  recordBusEmit,
  recordHandlerDuration,
  recordJobOutcome,
  recordSubscriberConnect,
  recordSubscriberDisconnect,
  recordInferenceUsage,
} from '@semiont/observability';

recordBusEmit('mark:create', 'browse');
recordHandlerDuration('stower', 'mark:create', durationMs);
recordJobOutcome('reference-annotation', 'completed', durationMs);
recordSubscriberConnect();
recordInferenceUsage({ model: 'gemma3:27b', inputTokens: 412, outputTokens: 87 });
```

### Provider registration

Long-lived snapshots (job queue depth, vector index size) are gauges, registered via callback so the SDK can pull at metric-export time:

```ts
import {
  registerJobQueueProvider,
  registerVectorIndexSizeProvider,
} from '@semiont/observability';

registerJobQueueProvider(() => ({
  pending: jobs.pending.size,
  running: jobs.running.size,
}));

registerVectorIndexSizeProvider(() => qdrant.getCollectionInfo());
```

## Implementation notes

This package wires `BasicTracerProvider` and `MeterProvider` (stable `@opentelemetry/sdk-trace-base` 2.x line) directly, plus `AsyncLocalStorageContextManager` for Node async-context propagation. It deliberately avoids `@opentelemetry/sdk-node` because that package's experimental 0.x versions cross-depend on older 2.0.x SDK lines, forcing npm to nest duplicate copies of the stable packages and bloating consumer bundles.

`initObservabilityNode` is idempotent — calling twice is a no-op and returns `false` on the second call. Both providers shut down cleanly on `SIGTERM` / `SIGINT`.

## License

Apache-2.0 — see [LICENSE](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE).

## Related packages

- [`@semiont/core`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/core) — Tier 1 `busLog`, domain types
- [`@semiont/sdk`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk) — high-level Semiont client, the primary consumer of this package's spanning helpers
- [`@semiont/api-client`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/api-client) — HTTP transport, propagates `traceparent` on every request
