# Observability

Semiont emits OpenTelemetry traces from every process — backend,
worker, smelter, and the SPA. Tracing is **off by default**: with no
exporter configured, the SDK no-ops (spans are created in-memory and
discarded at flush). Set an exporter endpoint to start receiving
spans.

## What gets traced

The transport contract is the single instrumentation layer. Every bus
emit, content put/get, in-process actor handler, and worker job
becomes a span. Trace context propagates over HTTP `traceparent`
headers and SSE `_trace` payload fields.

| Span name              | Site                                      | Kind     |
|------------------------|-------------------------------------------|----------|
| `bus.emit:<channel>`   | `HttpTransport.emit` / `LocalTransport.emit` | producer |
| `bus.recv:<channel>`   | Wire-parse / bridge subscriber            | consumer |
| `bus.dispatch:<channel>` | Backend `/bus/emit` handler             | server   |
| `actor.<name>:<channel>` | In-process subscriber (Stower / Gatherer / Matcher / Browser / Smelter) | consumer |
| `content.{put,get}`    | `HttpContentTransport.*` / `LocalContentTransport.*` | client / internal |
| `content.{put,get}.server` | Backend `/resources*` routes          | server   |
| `job:<type>`           | Worker `handleJob`                        | consumer |

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

### Backend / worker / smelter (Node)

Standard OTel env vars. Set them on the process — for local dev,
inherit from your shell; for containers, add to compose / ECS task env.

| Variable                          | Default                                | Purpose                            |
|-----------------------------------|----------------------------------------|------------------------------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | (none — uses console exporter)         | OTLP HTTP collector URL            |
| `OTEL_EXPORTER_OTLP_HEADERS`      | (none)                                 | Auth headers for SaaS APMs         |
| `OTEL_SERVICE_NAME`               | `semiont-backend` / `-worker` / `-smelter` | Service identity                |
| `OTEL_TRACES_SAMPLER`             | `parentbased_always_on`                | Sampler                            |
| `OTEL_TRACES_SAMPLER_ARG`         | (n/a)                                  | Ratio for traceidratio samplers    |
| `OTEL_SDK_DISABLED`               | `false`                                | Set `true` to skip init entirely   |

When no `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the SDK falls back to a
console exporter (stderr). Useful for local dev — set
`OTEL_LOG_LEVEL=debug` for more detail.

### Frontend (SPA)

Build-time env, read by Vite. Set when building the SPA:

| Variable                       | Purpose                                  |
|--------------------------------|------------------------------------------|
| `VITE_OTEL_OTLP_ENDPOINT`      | OTLP HTTP collector URL (with CORS open) |

Without `VITE_OTEL_OTLP_ENDPOINT`, the SPA does not initialize the
SDK — no spans emitted, no overhead.

## Recommended targets

Semiont does not store traces; the operator picks a backend.

| Deployment              | Recommended target                                                                              |
|-------------------------|-------------------------------------------------------------------------------------------------|
| Local dev (default)     | Console exporter to stderr — no backend needed.                                                 |
| Local dev (richer)      | `docker compose` Jaeger sidecar at `http://jaeger:4318`.                                        |
| Self-hosted prod        | Jaeger (Cassandra/ES-backed) or Grafana Tempo (S3-backed, pairs with Loki).                      |
| AWS prod                | AWS X-Ray via the AWS Distro for OpenTelemetry collector sidecar (translates OTLP → X-Ray).      |
| SaaS APM                | Honeycomb / Datadog / New Relic / Lightstep all accept OTLP — set endpoint + auth header.        |
| Multi-backend / scrubbing | Run the standard `otelcol` between Semiont and downstream backends. Pure operator config.      |

## Local quickstart with Jaeger

```bash
# 1. Run Jaeger
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# 2. Point Semiont at it
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=semiont-backend
semiont start --service backend

# 3. Browse traces at http://localhost:16686
```

## Two invariants

1. **No co-location with KB data.** Traces never go in Postgres, the
   event log, Qdrant, or Neo4j. Observability data is high-volume,
   short-retention, lossy-is-fine; KB data is durable, append-only,
   source of truth. Mixing them is an antipattern.
2. **No exporter, no traces.** If the operator configures nothing, the
   SDK no-ops — spans are created in-memory and dropped at the
   `BatchSpanProcessor` flush. Zero network cost, zero storage cost.

## Relationship to other layers

- **Structured logger** (`getLogger()`) — JSON-line, level-filtered,
  always on. Logs *semantic events* (validation failed, user
  authenticated). Goes to log aggregator. Tier 3 will tag every log
  line with the active span's `trace_id` / `span_id` for
  log↔trace navigation.
- **`busLog`** — grep-text, opt-in via `SEMIONT_BUS_LOG=1`. Logs
  every wire-level bus event. Targets developer terminal/stderr.
  Forward-compatible with traces — the `cid` it prints is the prefix
  of the W3C trace-id.
- **OTel spans** (this doc) — distributed tracing. Targets a
  collector + APM backend.

All three correlate by `correlationId` today; once Tier 3 lands, all
three correlate by W3C `trace_id`.

## Metrics (Tier 3)

Alongside traces, every Node process exports a small set of metrics
through the same OTLP endpoint. No extra config required — the
`OTEL_EXPORTER_OTLP_ENDPOINT` you set for traces also drives metrics.

| Metric                       | Type      | Attributes                                   | Where                                         |
|------------------------------|-----------|----------------------------------------------|-----------------------------------------------|
| `semiont.bus.emit`           | counter   | `bus.channel`, `bus.scope`                   | Every transport `emit` (frontend, in-process, server) |
| `semiont.handler.duration`   | histogram | `actor`, `bus.channel`                       | Every actor handler (Stower / Gatherer / Matcher / Browser / Smelter) |
| `semiont.job.outcome`        | counter   | `job.type`, `job.outcome` (`completed` / `failed`) | Worker `handleJob`                       |
| `semiont.job.duration`       | histogram | `job.type`, `job.outcome`                    | Worker `handleJob`                            |

Additional vars:

| Variable                          | Default | Purpose                                       |
|-----------------------------------|---------|-----------------------------------------------|
| `OTEL_METRIC_EXPORT_INTERVAL`     | `30000` | Push interval in ms                           |

With no `OTEL_EXPORTER_OTLP_ENDPOINT`, metrics fall back to the
console exporter (same as traces) — useful for verifying instruments
fire during dev without running a collector.

## Log correlation (Tier 3)

Every structured log line emitted by the backend Winston logger
(`getLogger()`) and the worker/smelter Winston loggers
(`createProcessLogger()`) is now tagged with `trace_id` and `span_id`
when an active span exists. Log queries in CloudWatch / Loki / Datadog
can be filtered by `trace_id` and joined with the trace UI.

```json
{"level":"info","msg":"emit","channel":"mark:create","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"}
```

When no SDK is initialized (or no span is active), the helper returns
`undefined` and nothing is added — same log shape as before.

## Limitations

- **Outbound services not auto-instrumented.** Anthropic / OpenAI /
  Ollama / Postgres / Qdrant calls are not traced by default.
  Operators who want this can add `@opentelemetry/instrumentation-pg`,
  `@opentelemetry/instrumentation-http`, etc. to their own startup
  shim — Semiont's observability package deliberately doesn't bundle
  them so the dependency surface stays small.
- **Frontend uses `XMLHttpRequest` / `fetch` directly** for the
  transport's underlying calls. Auto-instrumenting these is
  intentionally not enabled — the transport-call spans we emit name
  the operation semantically (`bus.emit:mark:create`) instead of by
  URL.

## Plan reference

See [`.plans/OBSERVABILITY.md`](../../.plans/OBSERVABILITY.md) for the
tiered design (Tier 1 = grep-line bus log, Tier 2 = these spans,
Tier 3 = metrics + log correlation).
