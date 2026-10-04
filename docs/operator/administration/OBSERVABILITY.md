# Observability

A stack can be observed three ways, each switched on separately:

1. **Traces.** Every service and the Browser can export OpenTelemetry spans. A service exports nothing until it is given an OTLP endpoint; the launcher gives every service one.
2. **Metrics and log correlation.** Counters, histograms and gauges go to the same endpoint, and every structured log line carries the `trace_id` and `span_id` of the span it was written in.
3. **The `busLog` timeline.** With `SEMIONT_BUS_LOG=1`, a process writes one line per bus event, in a format made for `grep`. It is a developer's tool: see [Bus logging](../../../tests/e2e/docs/bus-logging.md).

All three share the W3C `trace_id`: the `cid` that `busLog` prints is its first eight hex digits.

## What gets traced

The transport contract is the single instrumentation layer. Every bus
emit, content put/get, in-process actor handler, and worker job
becomes a span. Trace context propagates over HTTP `traceparent`
headers and SSE `_trace` payload fields.

| Span name              | Site                                      | Kind     |
|------------------------|-------------------------------------------|----------|
| `bus.emit:<channel>`   | `HttpTransport.emit` / `LocalTransport.emit` | producer |
| `bus.recv:<channel>`   | Wire-parse / bridge subscriber            | consumer |
| `actor.<name>:<channel>` | In-process subscriber (Stower / Gatherer / Matcher / Browser / Smelter) | consumer |
| `content.{put,get}`    | `HttpContentTransport.*` / `LocalContentTransport.*` | client / internal |
| `job:<type>`           | Worker `handleJob`                        | consumer |

What the Rust services export is specified, with kinds and attributes, in
[`specs/src/service-telemetry/telemetry.json`](../../../specs/src/service-telemetry/telemetry.json):
the gateway's own spans — `bus.dispatch:<channel>`, `sse.deliver:<channel>`,
`content.{get,put}.server` and the `archivist.*` client spans. What an SDK's
transports export, in any language, is specified in
[`specs/src/sdk-telemetry/telemetry.json`](../../../specs/src/sdk-telemetry/telemetry.json):
the `bus.emit` and `bus.recv` spans, the `content.*` client spans, and the
count of emits a client sends. The dispatcher reaches the bus through the Rust
SDK, so it exports the bus rows of that table beside its own. Each service's
conformance suite holds it to its rows in both directions, and the SDK suite
holds each SDK to the SDK table.

The `archivist.*` spans are the third hop on the byte path. The gateway's `content.{put,get}.server` span makes a network call to the archivist, and without a span of its own, a slow archivist would read as a slow gateway.

A typical "open resource" trace, parented by the SPA's transport call:

```
bus.emit:browse:resource-requested              [HttpTransport.emit]
└─ bus.dispatch:browse:resource-requested       [/bus/emit handler]
   └─ actor.browser:browse:resource-requested   [Browser handler]
      └─ bus.emit:browse:resource-result        [Browser → bus]
         └─ bus.recv:browse:resource-result     [SPA wire-parse]
```

A worker job adds:

```
job:reference-annotation                        [worker handleJob]
├─ bus.emit:job:report-progress                 [progress emits]
├─ content.put                                  [yield.resource() upload]
│  └─ content.put.server                        [/resources POST]
└─ bus.emit:mark:create
```

## Configuring an exporter

### The services

The standard OpenTelemetry variables, set in each service's environment. The launcher sets the endpoint for every service it starts; on your own platform, set it in each container's environment.
The Rust services — the gateway and the dispatcher — read the ones their
environment table lists ([`variables.json`](../../../specs/src/service-environment/variables.json))
and configure their SDK from them; the table below is the sidecars'.

| Variable                          | Default                                | Purpose                            |
|-----------------------------------|----------------------------------------|------------------------------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | (none — SDK does not initialize)       | OTLP HTTP collector URL            |
| `OTEL_EXPORTER_OTLP_HEADERS`      | (none)                                 | Auth headers for SaaS APMs         |
| `OTEL_SERVICE_NAME`               | `semiont-<service>`, such as `semiont-gateway` | Service identity            |
| `OTEL_TRACES_SAMPLER`             | `parentbased_always_on`                | Sampler                            |
| `OTEL_TRACES_SAMPLER_ARG`         | (n/a)                                  | Ratio for traceidratio samplers    |
| `OTEL_CONSOLE_EXPORTER`           | `false`                                | Set `true` for stderr exporter (dev only) |
| `OTEL_SDK_DISABLED`               | `false`                                | Set `true` to skip init entirely   |

**Off-by-default invariant**: with neither
`OTEL_EXPORTER_OTLP_ENDPOINT` nor `OTEL_CONSOLE_EXPORTER=true` set,
the SDK does not initialize — the `@opentelemetry/api` no-op tracer
takes over and `withSpan` becomes a free pass-through. This keeps a deployment with no collector from flooding its own logs.

Without a collector, `OTEL_CONSOLE_EXPORTER=true` prints spans and metrics to the service's output.

### A Rust client

An application built on the Rust SDK installs its own OpenTelemetry (a tracer
provider, a meter provider and the W3C propagator, registered as the
process's) and the transport reports to it:
[`semiont-telemetry`](../../../packages/telemetry-rust/README.md) says how.
With none installed, nothing is recorded and no trace context is sent.

### Browser (SPA)

Build-time env, read by Vite. Set when building the SPA:

| Variable                       | Purpose                                  |
|--------------------------------|------------------------------------------|
| `VITE_OTEL_OTLP_ENDPOINT`      | OTLP HTTP collector URL (with CORS open) |

Without `VITE_OTEL_OTLP_ENDPOINT`, the SPA does not initialize the
SDK — no spans emitted, no overhead.

## Recommended targets

Semiont stores no telemetry; you choose where it goes. The launcher chooses for a stack it runs: an OpenTelemetry Collector takes in everything, Jaeger stores the traces and Prometheus the metrics.

| Deployment              | Recommended target                                                                              |
|-------------------------|-------------------------------------------------------------------------------------------------|
| A stack the launcher runs | The launcher's trio: OTel collector (always on, OTLP `:4318`) → Jaeger for traces (UI `:16686`), Prometheus for metrics (UI `:9090`). |
| A collector of your own | Point `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP intake; or `OTEL_CONSOLE_EXPORTER=true` for stderr output. |
| Self-hosted             | Jaeger (Cassandra/ES-backed) or Grafana Tempo (S3-backed, pairs with Loki).                      |
| A cloud's own tracing   | Through that cloud's OpenTelemetry Collector distribution, which translates OTLP to its format.  |
| SaaS APM                | Honeycomb / Datadog / New Relic / Lightstep all accept OTLP — set endpoint + auth header.        |
| Several backends, or scrubbing | Run the standard `otelcol` between Semiont and the backends.                              |

## With the launcher

The [`semiont` launcher](../../../apps/launcher/README.md) sets all of it up by default:

```bash
semiont start
# traces:  http://localhost:16686   (Jaeger)
# metrics: http://localhost:9090    (Prometheus)
```

The OTel collector **always** runs (OTLP on `:4318`, its own readout on `:24110`) and
`OTEL_EXPORTER_OTLP_ENDPOINT` is wired into all seven service containers; `--no-observe`
skips only Jaeger and Prometheus — the collector then discards traces, and the metrics
readout is still served for anything that wants to scrape it. Jaeger's own OTLP ingest
sits on `:14318` (the collector owns `:4318` and forwards). A single service started with
`--service` exports only when the stack's collector is already running. Do not run a
Jaeger of your own on `:4318`: that port is the collector's.

### Verifying spans are flowing

```bash
# Services that have reported spans
curl -s http://localhost:16686/api/services | jq -r '.data[]'

# Operations on a service
curl -s http://localhost:16686/api/services/semiont-gateway/operations | jq -r '.data[]'

# Cross-service traces (most useful for debugging propagation)
curl -s 'http://localhost:16686/api/traces?service=semiont-gateway&limit=200&lookback=10m' \
  | jq -r '.data[] | select(([.processes[].serviceName] | unique | length) > 1) | "\(.traceID) services=\([.processes[].serviceName] | unique | join(","))"'

# Metrics landing in Prometheus (via the collector's readout)
curl -s 'http://localhost:9090/api/v1/label/__name__/values' | jq -r '.data[]' | head
```

If Jaeger only knows about itself (`jaeger-all-in-one`), no Semiont
process has exported spans. Most likely causes:

1. `OTEL_EXPORTER_OTLP_ENDPOINT` is set but unreachable — verify with
   `container exec semiont-gateway wget -qO- http://...:4318` from
   inside the gateway container.
2. `OTEL_SDK_DISABLED=true` is set on the process, or neither
   `OTEL_EXPORTER_OTLP_ENDPOINT` nor `OTEL_CONSOLE_EXPORTER=true` is: check
   with `container exec semiont-gateway env | grep OTEL_`.

If services appear but every trace is single-service (no cross-service
propagation), the W3C trace-context propagator likely isn't
registered. `initObservabilityNode` registers it explicitly because
we don't use `@opentelemetry/sdk-node` (which would do it
implicitly) — see `packages/observability/src/node.ts`.

## Two invariants

1. **No co-location with KB data.** Traces never go in Postgres, the
   event log, Qdrant, or Neo4j. Observability data is high-volume,
   short-retention, lossy-is-fine; KB data is durable, append-only,
   source of truth. Mixing them is an antipattern.
2. **No exporter, no traces.** If the operator configures nothing, the
   SDK no-ops — spans are created in-memory and dropped at the
   `BatchSpanProcessor` flush. Zero network cost, zero storage cost.

## Relationship to the structured logger and `busLog`

- **Structured logger** (the Rust services', in `packages/observability-rust/src/logging.rs`;
  `createProcessLogger()` in workers/smelter) — JSON-line,
  level-filtered, always on. Logs semantic events (validation failed,
  user authenticated). Goes to log aggregator. Every line is auto-
  tagged with the active span's `trace_id` / `span_id` when one
  exists — operators can jump from a log line in CloudWatch / Loki /
  Datadog to the trace in Tempo / Jaeger / X-Ray.
- **`busLog`** — grep-text, opt-in via `SEMIONT_BUS_LOG=1` (a service process) or
  `window.__SEMIONT_BUS_LOG__ = true` (browser). One line per
  cross-process bus event. Targets developer terminal / stderr / e2e
  fixture capture. The `cid` it prints is the first 8 hex of the
  W3C trace-id, so a `busLog` timeline collates with traces in the
  APM UI.
- **OTel spans + metrics** (this doc) — distributed tracing and
  metrics over OTLP. Targets a collector + APM gateway.

## Metrics

Alongside traces, every Node process exports a small set of metrics
through the same OTLP endpoint. No extra config required — the
`OTEL_EXPORTER_OTLP_ENDPOINT` you set for traces also drives metrics.

| Metric                       | Type             | Attributes                                              | Where                                         |
|------------------------------|------------------|---------------------------------------------------------|-----------------------------------------------|
| `semiont.bus.sent`           | counter          | `bus.channel`, `bus.scope`                              | Every transport `emit` (Browser, in-process, server): an emit a client sent |
| `semiont.handler.duration`   | histogram        | `actor`, `bus.channel`                                  | Every actor handler (Stower / Gatherer / Matcher / Browser / Smelter) |
| `semiont.job.outcome`        | counter          | `job.type`, `job.outcome` (`completed` / `failed`)      | Worker `handleJob`                       |
| `semiont.job.duration`       | histogram        | `job.type`, `job.outcome`                               | Worker `handleJob`                            |
| `semiont.inference.calls`    | counter          | `inference.provider`, `inference.model`, `inference.outcome` | Anthropic + Ollama clients               |
| `semiont.inference.tokens`   | counter          | `inference.provider`, `inference.model`, `inference.direction` (`input`/`output`) | Anthropic + Ollama (when usage exposed) |
| `semiont.inference.duration` | histogram        | `inference.provider`, `inference.model`, `inference.outcome` | Anthropic + Ollama clients               |
| `semiont.detection.calls`    | counter          | `detection.label`, `detection.outcome` (`success`/`truncated`/`collapsed`/`timeout`/`error`), `detection.depth`, `detection.reroll` | Worker detection — one row per model call, failed attempts included |
| `semiont.detection.call.duration` | histogram   | same as `semiont.detection.calls`                       | Worker detection per-call wall time           |
| `semiont.detection.call.items` | histogram      | same as `semiont.detection.calls`                       | Annotations returned per call — against input size, this is yield |
| `semiont.detection.call.tokens` | histogram     | same, plus `detection.direction` (`input`/`output`)     | Provider-reported tokens per detection call; kept separate from `semiont.inference.tokens` because that series carries no subdivision depth |
| `semiont.detection.anchors`  | counter          | `detection.label`, `anchor.method` (`unique-match`/`context-recovered`/`first-of-many`/`fuzzy-match`) | Every annotation anchoring — the degraded-method **rate** is the precision signal, so clean outcomes are counted too |
| `semiont.process.restarts`   | observable gauge | (none)                                                  | Every supervised service — times the in-container supervisor restarted the process, read back from the supervisor's event log. The series exists only when the run set `SEMIONT_SUPERVISE` (local stacks); absent, not `0`, everywhere else |

The gateway's and the dispatcher's metrics — the bus counters,
`semiont.sse.subscribers`, `semiont.bus.correlation.size`,
`semiont.job.queue.size`, and the process and runtime gauges — are specified,
with their instruments, attributes and attribute values, in
[`specs/src/service-telemetry/telemetry.json`](../../../specs/src/service-telemetry/telemetry.json).
The emits a client sent are a count of their own, `semiont.bus.sent`, a row of
[`specs/src/sdk-telemetry/telemetry.json`](../../../specs/src/sdk-telemetry/telemetry.json);
`semiont.bus.emit` is the gateway's count of the emits it accepted.

Additional vars:

| Variable                          | Default | Purpose                                       |
|-----------------------------------|---------|-----------------------------------------------|
| `OTEL_METRIC_EXPORT_INTERVAL`     | `30000` | Push interval in ms                           |

Metrics follow the same on/off invariant as traces — neither exports
unless an exporter is configured. With `OTEL_CONSOLE_EXPORTER=true`,
metric snapshots also print to stderr at each export interval.

## Log correlation

Every structured log line the gateway writes (in the `json` format its
configuration document selects) and the worker/smelter Winston loggers
(`createProcessLogger()`) write is tagged with `trace_id` and `span_id`
when an active span exists. Log queries in CloudWatch / Loki / Datadog
can be filtered by `trace_id` and joined with the trace UI.

```json
{"level":"info","msg":"emit","channel":"mark:create","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"}
```

When no SDK is initialized (or no span is active), the helper returns
`undefined` and nothing is added — same log shape as before.

## Limitations

- **Calls out to models and stores are not traced.** A call to Anthropic, Ollama, Neo4j or Qdrant has no span of its own. Inference is metered, by call, token and duration, in the `semiont.inference.*` metrics.
- **There is no metric for the size of the vector index.**
- **The Browser's spans name the operation, not the URL.** Its transport calls are traced as `bus.emit:mark:create` and the like; the underlying `fetch` is not instrumented separately.

## Related documentation

- [Bus logging](../../../tests/e2e/docs/bus-logging.md) — `busLog` format,
  enable flags, e2e capture API.
- [Architecture](../../architecture/ACTOR-MODEL.md) — actor topology and event-bus
  design that the trace and metric attributes describe.
- [Troubleshooting](./TROUBLESHOOTING.md) — incident workflows that
  reference traces and structured logs.
