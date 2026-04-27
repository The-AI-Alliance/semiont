# Observability

Semiont ships three layers of observability, each independently
toggleable:

1. **`busLog` grep timeline** — opt-in via `SEMIONT_BUS_LOG=1`. One
   line per cross-process bus event, in a grep-friendly format.
   Developer-terminal target. See
   [Bus logging](../../tests/e2e/docs/bus-logging.md) for the format,
   capture API, and e2e fixture integration.
2. **OpenTelemetry traces** (this doc) — distributed tracing from
   every process (backend, worker, smelter, SPA). Off by default; set
   `OTEL_EXPORTER_OTLP_ENDPOINT` to enable.
3. **OpenTelemetry metrics + log correlation** (this doc) — counters,
   histograms, and gauges across the same OTLP endpoint, plus
   `trace_id` / `span_id` auto-tagged on every structured log line.

All three correlate by W3C `trace_id` (the `cid` printed by `busLog`
is its first-8-hex prefix).

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
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | (none — SDK does not initialize)       | OTLP HTTP collector URL            |
| `OTEL_EXPORTER_OTLP_HEADERS`      | (none)                                 | Auth headers for SaaS APMs         |
| `OTEL_SERVICE_NAME`               | `semiont-backend` / `-worker` / `-smelter` | Service identity                |
| `OTEL_TRACES_SAMPLER`             | `parentbased_always_on`                | Sampler                            |
| `OTEL_TRACES_SAMPLER_ARG`         | (n/a)                                  | Ratio for traceidratio samplers    |
| `OTEL_CONSOLE_EXPORTER`           | `false`                                | Set `true` for stderr exporter (dev only) |
| `OTEL_SDK_DISABLED`               | `false`                                | Set `true` to skip init entirely   |

**Off-by-default invariant**: with neither
`OTEL_EXPORTER_OTLP_ENDPOINT` nor `OTEL_CONSOLE_EXPORTER=true` set,
the SDK does not initialize — the `@opentelemetry/api` no-op tracer
takes over and `withSpan` becomes a free pass-through. This prevents
accidental stderr / CloudWatch flooding when an operator deploys
without configuring a collector.

For local dev without a collector, set `OTEL_CONSOLE_EXPORTER=true`
to print spans + metrics to stderr.

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
| Local dev (default)     | SDK off — set `OTEL_CONSOLE_EXPORTER=true` for stderr output, or skip and rely on `busLog`.     |
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

### Containerized stack with `--observe`

The `template-kb`-style start script supports a `--observe` flag that
brings up Jaeger as a sidecar and wires `OTEL_EXPORTER_OTLP_ENDPOINT`
into backend / worker / smelter automatically:

```bash
ANTHROPIC_API_KEY=<key> NPM_REGISTRY=http://192.168.64.1:4873 \
  ./.semiont/scripts/start.sh --observe --no-cache --config anthropic \
  --email admin@example.com --password password
```

Use this for development / e2e workflows where you want to inspect
cross-service trace propagation without standing Jaeger up by hand.

### Verifying spans are flowing

```bash
# Services that have reported spans
curl -s http://localhost:16686/api/services | jq -r '.data[]'

# Operations on a service
curl -s http://localhost:16686/api/services/semiont-backend/operations | jq -r '.data[]'

# Cross-service traces (most useful for debugging propagation)
curl -s 'http://localhost:16686/api/traces?service=semiont-backend&limit=200&lookback=10m' \
  | jq -r '.data[] | select(([.processes[].serviceName] | unique | length) > 1) | "\(.traceID) services=\([.processes[].serviceName] | unique | join(","))"'
```

If Jaeger only knows about itself (`jaeger-all-in-one`), no Semiont
process has exported spans. Most likely causes:

1. `OTEL_EXPORTER_OTLP_ENDPOINT` is set but unreachable — verify with
   `container exec semiont-backend wget -qO- http://...:4318` from
   inside the backend container.
2. `@semiont/observability` isn't installed in the running backend.
   Verify: `container exec semiont-backend ls /home/semiont/.local/share/semiont/node_modules/@semiont/`.
3. Backend image was built before observability was bumped — rebuild
   with `--no-cache`.

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

- **Structured logger** (`getLogger()` on backend,
  `createProcessLogger()` in workers/smelter) — JSON-line,
  level-filtered, always on. Logs semantic events (validation failed,
  user authenticated). Goes to log aggregator. Every line is auto-
  tagged with the active span's `trace_id` / `span_id` when one
  exists — operators can jump from a log line in CloudWatch / Loki /
  Datadog to the trace in Tempo / Jaeger / X-Ray.
- **`busLog`** — grep-text, opt-in via `SEMIONT_BUS_LOG=1` (Node) or
  `window.__SEMIONT_BUS_LOG__ = true` (browser). One line per
  cross-process bus event. Targets developer terminal / stderr / e2e
  fixture capture. The `cid` it prints is the first 8 hex of the
  W3C trace-id, so a `busLog` timeline collates with traces in the
  APM UI.
- **OTel spans + metrics** (this doc) — distributed tracing and
  metrics over OTLP. Targets a collector + APM backend.

## Metrics (Tier 3)

Alongside traces, every Node process exports a small set of metrics
through the same OTLP endpoint. No extra config required — the
`OTEL_EXPORTER_OTLP_ENDPOINT` you set for traces also drives metrics.

| Metric                       | Type             | Attributes                                              | Where                                         |
|------------------------------|------------------|---------------------------------------------------------|-----------------------------------------------|
| `semiont.bus.emit`           | counter          | `bus.channel`, `bus.scope`                              | Every transport `emit` (frontend, in-process, server) |
| `semiont.handler.duration`   | histogram        | `actor`, `bus.channel`                                  | Every actor handler (Stower / Gatherer / Matcher / Browser / Smelter) |
| `semiont.job.outcome`        | counter          | `job.type`, `job.outcome` (`completed` / `failed`)      | Worker `handleJob`                       |
| `semiont.job.duration`       | histogram        | `job.type`, `job.outcome`                               | Worker `handleJob`                            |
| `semiont.inference.calls`    | counter          | `inference.provider`, `inference.model`, `inference.outcome` | Anthropic + Ollama clients               |
| `semiont.inference.tokens`   | counter          | `inference.provider`, `inference.model`, `inference.direction` (`input`/`output`) | Anthropic + Ollama (when usage exposed) |
| `semiont.inference.duration` | histogram        | `inference.provider`, `inference.model`, `inference.outcome` | Anthropic + Ollama clients               |
| `semiont.sse.subscribers`    | up-down counter  | (none)                                                  | `/bus/subscribe` connect/disconnect           |
| `semiont.job.queue.size`     | observable gauge | `job.status` (`pending`/`running`/`complete`/`failed`/`cancelled`) | Backend `FsJobQueue.getStats()` |

Additional vars:

| Variable                          | Default | Purpose                                       |
|-----------------------------------|---------|-----------------------------------------------|
| `OTEL_METRIC_EXPORT_INTERVAL`     | `30000` | Push interval in ms                           |

Metrics follow the same on/off invariant as traces — neither exports
unless an exporter is configured. With `OTEL_CONSOLE_EXPORTER=true`,
metric snapshots also print to stderr at each export interval.

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

- **Outbound services not auto-instrumented for tracing.** Anthropic /
  OpenAI / Ollama / Postgres / Qdrant calls are not auto-traced
  (Anthropic + Ollama *are* metered for token / call / duration via
  the `semiont.inference.*` family). Operators who want full
  outbound HTTP / DB tracing can add
  `@opentelemetry/instrumentation-pg`,
  `@opentelemetry/instrumentation-http`, etc. to their own startup
  shim — Semiont's observability package deliberately doesn't bundle
  them so the dependency surface stays small.
- **No vector-index-size metric yet.** Adding it requires a new
  `count()` method on the `VectorStore` interface implemented across
  all backends (Qdrant, in-memory). Not urgent; deferred until
  capacity-planning needs surface.
- **Frontend uses `XMLHttpRequest` / `fetch` directly** for the
  transport's underlying calls. Auto-instrumenting these is
  intentionally not enabled — the transport-call spans we emit name
  the operation semantically (`bus.emit:mark:create`) instead of by
  URL.

## Related documentation

- [Bus logging](../../tests/e2e/docs/bus-logging.md) — `busLog` format,
  enable flags, e2e capture API.
- [Architecture](../ARCHITECTURE.md) — actor topology and event-bus
  design that the trace and metric attributes describe.
- [Troubleshooting](./TROUBLESHOOTING.md) — incident workflows that
  reference traces and structured logs.
