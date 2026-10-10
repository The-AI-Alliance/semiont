# @semiont/observability

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+observability%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=observability)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=observability)
[![npm version](https://img.shields.io/npm/v/@semiont/observability.svg)](https://www.npmjs.com/package/@semiont/observability)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/observability.svg)](https://www.npmjs.com/package/@semiont/observability)
[![License](https://img.shields.io/npm/l/@semiont/observability.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Tracing, metrics and the process logger for Semiont's TypeScript services and transports, on [OpenTelemetry](https://opentelemetry.io). It is off unless a process is given somewhere to export to: with no endpoint configured, every function here does nothing.

## Who uses it

- **Each Node service starts it** at its entry point, and takes its logger from it: the Worker in [`@semiont/jobs`](../jobs/README.md), and the Librarian, Smelter and Weaver in [`@semiont/make-meaning`](../make-meaning/README.md).
- **The actors** wrap each bus handler in a span, and the packages under them record what they measure: [`@semiont/inference`](../inference/README.md), [`@semiont/jobs`](../jobs/README.md), [`@semiont/content`](../content/README.md) and [`@semiont/event-sourcing`](../event-sourcing/README.md).
- **[`@semiont/http-transport`](../http-transport/README.md)** runs each request in a span and carries the trace across the wire. That is how this package comes to be in the Browser's bundle.

The gateway, the dispatcher and the Archivist are Rust, and have a crate of their own for this.

**Building an application?** You do not need this package. The SDK's transport reports through OpenTelemetry's global API, so an application that registers a tracer of its own sees the transport's spans in its traces.

## What is in it

| Import | |
|---|---|
| `@semiont/observability` | Runs in Node and in a browser. Spans: `withSpan`, and `withActorSpan` for a bus handler. Trace context across the bus: `getActiveTraceparent`, `extractTraceparent`, `withTraceparent`; and `withoutTrace`, for work that begins a trace of its own. `getLogTraceContext`, for a log line. The metric recorders (`record…`) and the gauges a process registers (`register…Provider`) |
| `@semiont/observability/node` | `initObservabilityNode` and `shutdownObservabilityNode`: the tracer, the meter, the exporter and the context manager of a Node process |
| `@semiont/observability/process-logger` | `createProcessLogger(component)`: a service's structured logger. Each line carries the trace and span that were active when it was written |

Each recorder says what it measures where it is defined, in [src/index.ts](src/index.ts).

## Example

```typescript
import { initObservabilityNode } from '@semiont/observability/node';
import { withSpan } from '@semiont/observability';

// Once, at the entry point, before anything that makes a span.
initObservabilityNode({ serviceName: 'semiont-worker' });

const length = await withSpan('read-document', async (span) => {
  span.setAttribute('document.pages', 12);
  return 4096;
});
```

## What a change must keep

- **Off by default, and free when off.** With no exporter configured, the tracer and the meter are OpenTelemetry's own no-ops. Nothing here may do work, or fail, because telemetry is not set up.
- **The main import runs in a browser.** It imports no Node builtin. What needs Node is in `/node` and `/process-logger`.
- **One trace across the bus.** A request carries the active span as a W3C `traceparent` header, and a frame relayed over the stream carries it in its `_trace` field. A handler continues that trace rather than starting one.
- **No domain logic.** The package gives the helpers and the recorders. What is worth a span or a count is decided where the work happens.
- **Initialized once.** `initObservabilityNode` is called at a process's entry point. A second call does nothing and returns `false`.

## Documentation

- [API reference](docs/API.md): the helpers, with an example of each, and the process logger.
- [Observability](../../docs/operator/administration/OBSERVABILITY.md): the variables that turn it on, and where a stack sends its telemetry.

## License

Apache-2.0
