# Observability

A stack can be observed three ways, each switched on separately:

1. **Traces.** Every service and the Browser can export OpenTelemetry spans. A service exports nothing until it is given an OTLP endpoint; the launcher gives every service one.
2. **Metrics and log correlation.** Counters, histograms and gauges go to the same endpoint, and every structured log line carries the `trace_id` and `span_id` of the span it was written in.
3. **The `busLog` timeline.** With `SEMIONT_BUS_LOG=1`, a process writes one line per bus event, in a format made for `grep`. It is a developer's tool: see [Bus logging](../../../tests/e2e/docs/bus-logging.md).

All three share the W3C `trace_id`: a `busLog` line written inside a span carries `trace=`, the id's first eight hex digits.

## What gets traced

The transport contract is the single instrumentation layer. Every bus
emit, content put/get, and worker job
becomes a span. Trace context propagates over HTTP `traceparent`
headers and, on a frame relayed over SSE, the payload field the bus
registry names (`trace` in [`specs/src/bus/registry.json`](../../../specs/src/bus/registry.json)).

The spans are in the tables below, by who exports them. What the Rust services, the
Worker service, the Weaver, the Smelter and the Librarian export is specified, with kinds and attributes, in
[`specs/src/service-telemetry/telemetry.json`](../../../specs/src/service-telemetry/telemetry.json),
and what an SDK's transports export, in any language, in
[`specs/src/sdk-telemetry/telemetry.json`](../../../specs/src/sdk-telemetry/telemetry.json),
which also has the count of emits a client sends. Each service's conformance suite holds it
to its rows in both directions, and the SDK suite holds each SDK to the SDK table.

In a span's name `{channel}` is the bus channel and `{jobType}` the job's type. **When** is the
services' table's word for when a span is there: `traffic`, once
the service has had something of its kind to do.

An SDK's transports, in whatever process they run: the Browser, and the
services that reach the bus through an SDK. The dispatcher, the Archivist, the Weaver, the Smelter
and the Librarian make no span of their own. The first four export the two bus rows; the Librarian
exports those and `content.get_anchored_text`, for the anchored text it reads; the Worker service
exports those and `content.put`, `content.get` and `content.get_anchored_text`, for the uploads and
reads it makes.

| Span                   | Kind     | Attributes                                              | What it is                                    |
|------------------------|----------|---------------------------------------------------------|-----------------------------------------------|
| `bus.emit:{channel}`   | producer | `bus.channel`, and `bus.scope` on a frame in a resource scope | A frame the client sent, in the trace of the work that sent it |
| `bus.recv:{channel}`   | consumer | `bus.channel`, and `bus.scope` on a frame in a resource scope | A frame the client received, and the work done for it, in the trace the frame was sent under |
| `content.put`          | client   | `content.format`, `content.size_bytes`                  | An upload |
| `content.get`          | client   | `resource.id`, and `content.stream` (`true`) on a read taken as a stream | A read of a resource's bytes |
| `content.get_graph`    | client   | `resource.id`                                           | A read of a resource's description |
| `content.get_annotations` | client | `resource.id`                                           | A read of a resource's annotations |
| `content.get_anchored_text` | client | `resource.id`                                        | A read of a resource's anchored text |

The gateway:

| Span                   | Kind     | Attributes                                              | When    | What it is                                    |
|------------------------|----------|---------------------------------------------------------|---------|-----------------------------------------------|
| `bus.dispatch:{channel}` | server | `bus.channel`                                           | traffic | An emit the gateway accepted, in the caller's trace when the request carried one |
| `sse.deliver:{channel}` | producer | `bus.channel`, `bus.cid`, and `bus.scope` on a reply in a resource scope | traffic | A correlated reply written to the stream of the client whose request it answers |
| `content.get.server`   | server   | `resource.id`                                           | traffic | A read of a resource's bytes |
| `content.put.server`   | server   | (none)                                                  | traffic | An upload |
| `archivist.resources.record` | client | `peer.service` (`archivist`)                      | traffic | An upload forwarded to the Archivist |
| `archivist.resources.describe` | client | `peer.service` (`archivist`)                    | traffic | A JSON-LD description asked of the Archivist |
| `archivist.resources.annotations` | client | `peer.service` (`archivist`)                 | traffic | A resource's annotations asked of the Archivist |
| `archivist.resources.anchored_text` | client | `peer.service` (`archivist`)               | traffic | A resource's anchored text asked of the Archivist |
| `archivist.content.get` | client  | `peer.service` (`archivist`)                            | traffic | Bytes read from the Archivist |
| `archivist.events.replay` | client | `peer.service` (`archivist`)                           | traffic | A scope's persisted events read from the Archivist for a replay |

The Worker service:

| Span                   | Kind     | Attributes                                              | When    | What it is                                    |
|------------------------|----------|---------------------------------------------------------|---------|-----------------------------------------------|
| `job:{jobType}`        | consumer | `job.type` (`mark`/`yield`), `job.motivation` on a `mark` job, `job.id`, `resource.id`, `semiont.kb` | traffic | A job a worker held, from the claim that handed it over to its conclusion |
| `detection:prepare`    | internal | `resource.id`, `media.type`, `semiont.kb` | traffic | A `mark` job's reading of its resource: the description's media type, and the text read by it |
| `inference:structured` | internal | `inference.provider` (`anthropic`/`google`/`llamacpp`/`ollama`/`openai`/`together`/`vllm`), `inference.model`, `inference.max_tokens`, `semiont.kb` | traffic | One generation a worker asked of its provider for an array of objects, from the request to its answer or its time bound |
| `inference:text`       | internal | `inference.provider` (`anthropic`/`google`/`llamacpp`/`ollama`/`openai`/`together`/`vllm`), `inference.model`, `inference.max_tokens`, `semiont.kb` | traffic | One generation a worker asked of its provider for text, from the request to its answer or its time bound |

The `archivist.*` spans are the third hop on the byte path. The gateway's `content.{put,get}.server` span makes a network call to the archivist, and without a span of its own, a slow archivist would read as a slow gateway.

A typical "open resource" trace, parented by the SPA's transport call:

```
bus.emit:browse:resource-requested              [HttpTransport.emit]
└─ bus.dispatch:browse:resource-requested       [/bus/emit handler]
   └─ bus.recv:browse:resource-requested        [the Archivist, answering]
      └─ bus.emit:browse:resource-result        [the Archivist's reply]
         └─ bus.recv:browse:resource-result     [SPA wire-parse]
```

A worker's `yield` job adds:

```
job:yield                                       [the Worker service]
├─ inference:text                               [the generation]
├─ bus.emit:job:report-progress                 [progress]
├─ content.put                                  [the upload of what was generated]
│  └─ content.put.server                        [/resources POST]
└─ bus.emit:mark:commit                         [the link to the new resource]
```

## Configuring an exporter

### The services

The standard OpenTelemetry variables, set in each service's environment. The launcher sets the endpoint for every service it starts; on your own platform, set it in each container's environment.
The Rust services — the gateway, the dispatcher and the Archivist — read the ones their
environment table lists ([`variables.json`](../../../specs/src/service-environment/variables.json))
and configure their SDK from them. The Worker service reads the ones
[WORKER-SERVICE.md](../../protocol/WORKER-SERVICE.md#environment) lists, the Weaver the ones
[WEAVER.md](../../protocol/WEAVER.md#environment) lists, the Smelter the ones
[SMELTER.md](../../protocol/SMELTER.md#environment) lists, and the Librarian the ones
[LIBRARIAN.md](../../protocol/LIBRARIAN.md#environment) lists. Every service reads these four:

| Variable                          | Default                                | Purpose                            |
|-----------------------------------|----------------------------------------|------------------------------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | (none — nothing is exported)           | OTLP HTTP collector URL            |
| `OTEL_SERVICE_NAME`               | `semiont-<service>`, such as `semiont-gateway` | Service identity            |
| `OTEL_CONSOLE_EXPORTER`           | `false`                                | Set `true` to print to the service's output (dev only) |
| `OTEL_SDK_DISABLED`               | `false`                                | Set `true` to export nothing, whatever else is set |

**Off-by-default invariant**: with neither
`OTEL_EXPORTER_OTLP_ENDPOINT` nor `OTEL_CONSOLE_EXPORTER=true` set,
a service installs no exporter: every span and every count its code
makes goes nowhere, and no trace context travels. This keeps a deployment with no collector from flooding its own logs.

Without a collector, `OTEL_CONSOLE_EXPORTER=true` prints spans and metrics to the service's output.

### A Rust client

An application built on the Rust SDK installs its own OpenTelemetry (a tracer
provider, a meter provider and the W3C propagator, registered as the
process's) and the transport reports to it:
[`semiont-telemetry`](../../../packages/rust/telemetry/README.md) says how.
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
| A collector of your own | Point `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP intake; or `OTEL_CONSOLE_EXPORTER=true` to print to the service's output. |
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
starts neither Jaeger nor Prometheus, and leaves running ones alone. The collector sends
traces to Jaeger whenever Jaeger answers, and discards them otherwise; the metrics readout
is served either way, for anything that wants to scrape it. Jaeger's own OTLP ingest
sits on `:14318` (the collector owns `:4318` and forwards). A single service started with
`--service` exports only when the collector is already running. Do not run a
Jaeger of your own on `:4318`: that port is the collector's.

The three are the machine's, not one knowledge base's: every knowledge base started on
the machine exports to the one collector, a start keeps them running when they are as it
would start them, and `semiont stop` stops them with the stack.
`semiont stop --service collector|traces|metrics` stops one alone.

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
   `container exec semiont-<kb>-gateway wget -qO- http://...:4318` from
   inside the gateway container (`<kb>` is the knowledge base's did:web
   domain made safe for a name: [the launcher's names](../services/OVERVIEW.md#the-launchers-names)).
2. `OTEL_SDK_DISABLED=true` is set on the process, or neither
   `OTEL_EXPORTER_OTLP_ENDPOINT` nor `OTEL_CONSOLE_EXPORTER=true` is: check
   with `container exec semiont-<kb>-gateway env | grep OTEL_`.

If services appear but every trace is single-service (no cross-service
propagation), a service between them exports nothing: one that installs
no exporter sends no trace context on. Check each service's `OTEL_`
variables as above.

### Which knowledge base

Every service that serves one knowledge base exports under a resource naming it:
`semiont.kb`, the knowledge base's DID (`did:web:<site.domain>`). The worker serves
several, so its resource names none. It carries `semiont.kb` instead on each span and
data point of its own rows, naming the knowledge base whose job the work was. What it
shares with other services names none: the process's own metrics, and what a
provider's driver counts of a generation (`semiont.inference.*`), since one engine
can serve several knowledge bases. In Jaeger the DID is a tag of each service's
process, and of each of the worker's spans of a job; the collector writes it on
every metric it hands Prometheus as the label `semiont_kb`:

```bash
# Traces of one knowledge base
curl -sG http://localhost:16686/api/traces --data-urlencode service=semiont-gateway \
  --data-urlencode 'tags={"semiont.kb":"did:web:example.org"}' --data-urlencode lookback=10m \
  | jq -r '.data[].traceID'

# The knowledge bases Prometheus holds metrics of
curl -sG http://localhost:9090/api/v1/label/semiont_kb/values | jq -r '.data[]'
```

`semiont status` reads only its own knowledge base's metrics out of the collector,
the jobs the worker concluded there among them.

## Two invariants

1. **No co-location with KB data.** Traces never go in Postgres, the
   event log, Qdrant, or Neo4j. Observability data is high-volume,
   short-retention, lossy-is-fine; KB data is durable, append-only,
   source of truth. Mixing them is an antipattern.
2. **No exporter, no traces.** If the operator configures nothing, a
   service installs nothing: no span is kept and nothing is sent. Zero
   network cost, zero storage cost.

## Relationship to the structured logger and `busLog`

- **Structured logger** (the Rust services', in `packages/rust/observability/src/logging.rs`;
  the Python services', in
  `packages/python/service/src/semiont_service/log.py`) — JSON-line,
  level-filtered, always on. Logs semantic events (validation failed,
  user authenticated). Goes to log aggregator. Every line is auto-
  tagged with the active span's `trace_id` / `span_id` when one
  exists — operators can jump from a log line in CloudWatch / Loki /
  Datadog to the trace in Tempo / Jaeger / X-Ray.
- **`busLog`** — grep-text, opt-in via `SEMIONT_BUS_LOG=1` (a service process) or
  `window.__SEMIONT_BUS_LOG__ = true` (browser). One line per
  cross-process bus event. Targets developer terminal / stderr / e2e
  fixture capture. A line written inside a span carries `trace=`, the
  first 8 hex of the W3C trace-id, so a `busLog` timeline collates with
  traces in the APM UI. A line shows the frame's payload, less the value
  of a member whose name is one a credential goes by (`token`, `password`,
  `apiKey` and the rest of a
  [short list](../../../specs/src/bus/log-cases.json)), which is written
  as `[withheld]`.
- **OTel spans + metrics** (this doc) — distributed tracing and
  metrics over OTLP. Targets a collector + APM gateway.

## Metrics

Alongside traces, every service exports metrics through the same OTLP
endpoint. No extra config required — the `OTEL_EXPORTER_OTLP_ENDPOINT`
you set for traces also drives metrics. The Browser exports spans only.

The first table is what more than one service exports: the emits an SDK's transport sent, the
requests the Worker service and the Librarian make of a model, and what every service says of
its own process.

| Metric                       | Type             | Attributes                                              | Where                                         |
|------------------------------|------------------|---------------------------------------------------------|-----------------------------------------------|
| `semiont.bus.sent`           | counter          | `bus.channel`, and `bus.scope` on a scoped emit         | Every SDK transport's emit: an emit a client sent |
| `semiont.inference.calls`    | counter          | `inference.provider`, `inference.model`, `inference.outcome` | The Worker service and the Librarian — each request of a model, by how it ended |
| `semiont.inference.tokens`   | counter          | `inference.provider`, `inference.model`, `inference.direction` (`input`/`output`) | The Worker service and the Librarian — the tokens a provider reported, where it reports any |
| `semiont.inference.duration` | histogram        | `inference.provider`, `inference.model`, `inference.outcome` | The Worker service and the Librarian — how long each request of a model took, in ms |
| `semiont.process.start_time` | gauge            | (none)                                                  | Every service — Unix seconds at which the process started; a change means it restarted |
| `semiont.process.restarts`   | gauge            | (none)                                                  | Every supervised service — times the in-container supervisor restarted the process, read back from the supervisor's event log. The series exists only when the run set `SEMIONT_SUPERVISE` (local stacks); absent, not `0`, everywhere else |
| `semiont.process.abnormal_exit` | counter       | `reason` (`unhandledRejection`/`uncaughtException`)     | Every service — a fatal error, counted just before the process exits |
| `semiont.runtime.event_loop.lag` | gauge        | `lag.stat` (`mean`/`p99`/`max`)                     | Every service — event-loop delay over the last export interval, in ms: time the process could serve nothing |
| `semiont.runtime.heap`       | gauge            | `heap.stat` (`used`/`total`/`limit`/`rss`)              | Every service — process memory in bytes |

The gateway, the dispatcher and the Archivist are Rust and export their own metrics,
specified with their instruments, attributes and attribute values in
[`specs/src/service-telemetry/telemetry.json`](../../../specs/src/service-telemetry/telemetry.json):
the `semiont.process.*` and `semiont.runtime.*` instruments of the rows above, and the rows
below. **When** is that table's word for when a series is there: `export`, whenever the
service exports at all; `traffic`, from the first thing of its kind the service has to count.

The gateway:

| Metric                       | Type             | Attributes                                              | When    | What it is                                    |
|------------------------------|------------------|---------------------------------------------------------|---------|-----------------------------------------------|
| `semiont.bus.emit`           | counter          | `bus.channel`, and `bus.scope` on an emit in a resource scope | traffic | Emits the gateway accepted |
| `semiont.bus.reply.suppressed` | counter        | `bus.channel`                                           | traffic | Correlated replies withheld from a subscriber that did not ask for them |
| `semiont.bus.resume_gap`     | counter          | `bus.resume_gap.reason`                                 | traffic | Resumes answered with a gap, by the gap's reason |
| `semiont.bus.unanswerable`   | counter          | `bus.channel`                                           | traffic | Requests no participant could answer. Only a plane that can count subscribers counts them: the `in-process` signal plane |
| `semiont.sse.subscribers`    | up-down counter  | (none)                                                  | traffic | Open bus streams |
| `semiont.gateway.refused`    | counter          | `refused.reason` (`streams`/`emit-rate`/`unanswered-requests`/`capacity`/`connections`) | traffic | Requests a limit refused — a principal's streams or emit bucket, a client's unanswered requests, the process's queued bytes — and connections closed at its connection cap |
| `semiont.gateway.unauthenticated` | counter     | `unauthenticated.reason` (`missing_token`/`invalid_token`/`invalid_media_token`) | traffic | Requests answered 401, by why: no bearer token, a bearer token refused, a media token refused |
| `semiont.bus.correlation.size` | gauge          | `correlation.kind` (`claims`/`claims_max`)              | export  | Outstanding request claims, and the cap on them |

The emits a client sent are a count of their own, `semiont.bus.sent`, a row of
[`specs/src/sdk-telemetry/telemetry.json`](../../../specs/src/sdk-telemetry/telemetry.json);
`semiont.bus.emit` is the gateway's count of the emits it accepted.

The dispatcher:

| Metric                       | Type             | Attributes                                              | When    | What it is                                    |
|------------------------------|------------------|---------------------------------------------------------|---------|-----------------------------------------------|
| `semiont.job.queue.size`     | gauge            | `job.status` (`pending`/`running`/`complete`/`failed`/`cancelled`) | export | The jobs in the queue, by status |

The Archivist:

| Metric                       | Type             | Attributes                                              | When    | What it is                                    |
|------------------------------|------------------|---------------------------------------------------------|---------|-----------------------------------------------|
| `semiont.archivist.fact_pump.depth` | gauge     | (none)                                                  | export  | Events appended to the record and not yet published on the bus. Zero at rest; a rising floor means publishing is behind its transport |
| `semiont.git.duration`       | histogram        | `git.command` (`add`/`rm`/`rev-parse`)                  | traffic | How long each git command the staging driver ran took, in milliseconds, the failing ones too |
| `semiont.git.staging.failures` | counter        | `reason` (`index-lock`/`other`)                         | traffic | Staging degradations: changes recorded and not staged, by why |

The Worker service is Python and exports its own too, specified in the same table: the
`semiont.process.*` and `semiont.runtime.*` instruments of the rows above, the three
`semiont.inference.*` rows for the generations it asks of its providers, and these:

| Metric                       | Type             | Attributes                                              | When    | What it is                                    |
|------------------------------|------------------|---------------------------------------------------------|---------|-----------------------------------------------|
| `semiont.job.outcome`        | counter          | `job.type` (`mark` / `yield`), `job.motivation` on a `mark` job, `job.outcome` (`completed` / `failed` / `cancelled`), `semiont.kb` | traffic | Every job a worker held, by how it ended |
| `semiont.job.duration`       | histogram        | `job.type`, `job.motivation` on a `mark` job, `job.outcome`, `semiont.kb` | traffic | How long a worker held each job, in ms    |
| `semiont.detection.calls`    | counter          | `detection.label`, `detection.outcome` (`success`/`truncated`/`collapsed`/`timeout`/`error`), `detection.depth`, `detection.reroll`, `semiont.kb` | traffic | Worker detection — one row per model call, failed attempts included |
| `semiont.detection.call.duration` | histogram   | `detection.label`, `detection.outcome`, `detection.depth`, `detection.reroll`, `semiont.kb` | traffic | Worker detection per-call wall time |
| `semiont.detection.call.items` | histogram      | `detection.label`, `detection.outcome`, `detection.depth`, `detection.reroll`, `semiont.kb` | traffic | Annotations returned per call — against input size, this is yield |
| `semiont.detection.call.tokens` | histogram     | `detection.label`, `detection.outcome`, `detection.depth`, `detection.reroll`, `detection.direction` (`input`/`output`), `semiont.kb` | traffic | Provider-reported tokens per detection call; kept separate from `semiont.inference.tokens` because that series carries no subdivision depth |
| `semiont.detection.anchors`  | counter          | `detection.label`, `anchor.method` (`unique-match`/`context-recovered`/`first-of-many`/`fuzzy-match`), `semiont.kb` | traffic | Every annotation anchoring — the degraded-method **rate** is the precision signal, so clean outcomes are counted too |

Of its memory (`semiont.runtime.heap`) the Worker service reports `total`, `limit` and `rss`,
and no `used`: Python keeps no count of how much of its heap is in use. Its `limit` is the
container's own memory limit. It counts a `semiont.process.abnormal_exit` for a failure
nothing caught once it had started, as `uncaughtException`.

The Weaver is Python too. It exports the `semiont.process.*` and `semiont.runtime.*`
instruments as the Worker service does, with the same three readings of its memory, and no
metric of its own. How many events it could not apply and how its two boot passes ended are
what its health says.

The Smelter is Python too. It exports the `semiont.process.*` and `semiont.runtime.*`
instruments as the Worker service does, with the same three readings of its memory, and this:

| Metric                       | Type             | Attributes                                              | When    | What it is                                    |
|------------------------------|------------------|---------------------------------------------------------|---------|-----------------------------------------------|
| `semiont.vector.index.size`  | gauge            | (none)                                                  | export  | Points the vector index holds, of resources and of annotations together. The Smelter counts them once in each export interval; while the index does not answer the count, the series has no point |

The rest is what its health says, of itself alone: the state of its stream of the record and
how many times that stream has dropped, how many events it has applied, could not apply and
has waiting, how its reconcile ended, and what its index is made by.

The Librarian is Python too. It exports the `semiont.process.*` and `semiont.runtime.*`
instruments as the Worker service does, with the same three readings of its memory, the three
`semiont.inference.*` rows for the requests it makes of its two models, and this:

| Metric                       | Type             | Attributes                                              | When    | What it is                                    |
|------------------------------|------------------|---------------------------------------------------------|---------|-----------------------------------------------|
| `semiont.gather.degraded`    | counter          | `projection` (`graph`/`vectors`/`suggestions`/`summary`/`relationship`) | traffic | A gather that went without something: `graph`, the graph did not come to hold the resource and the gather failed; `vectors`, the vector index failed or did not settle in time and the context carries no similar passages; and three for what a model failed to give: `suggestions`, the summary and suggestions of a resource; `summary`, the summary of the resource an annotation links to; `relationship`, the relationship sentence. A rising `graph` or `vectors` rate means the Weaver or the Smelter is not keeping up, or the vector index is failing; a rising rate of the other three means the Gatherer's model is |

No metric and no span says how long the Librarian took to answer a search or a gather.

Additional vars:

| Variable                          | Default | Purpose                                       |
|-----------------------------------|---------|-----------------------------------------------|
| `OTEL_METRIC_EXPORT_INTERVAL`     | `30000` | Push interval in ms                           |

Metrics follow the same on/off invariant as traces — neither exports
unless an exporter is configured. With `OTEL_CONSOLE_EXPORTER=true`,
metric snapshots also print to the service's output at each export interval.

## Log correlation

Every log line a service writes is tagged with `trace_id` and `span_id`
when an active span exists: the Rust services — the gateway, the
dispatcher and the Archivist — and the Worker service, the Weaver, the Smelter and the
Librarian, each by its logger. Log queries in CloudWatch / Loki / Datadog
can be filtered by `trace_id` and joined with the trace UI.

```json
{"level":"info","message":"emit","channel":"mark:create-request","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"}
```

When no SDK is initialized, or no span is active, neither field is added.

## Limitations

- **Calls out to models and stores are not traced.** A call to Anthropic, Ollama, Neo4j or Qdrant has no span of its own. Inference is metered, by call, token and duration, in the `semiont.inference.*` metrics.
- **The Browser's spans name the operation, not the URL.** Its transport calls are traced as `bus.emit:mark:create` and the like; the underlying `fetch` is not instrumented separately.

## Related documentation

- [Bus logging](../../../tests/e2e/docs/bus-logging.md) — `busLog` format,
  enable flags, e2e capture API.
- [Architecture](../../architecture/ACTOR-MODEL.md) — actor topology and event-bus
  design that the trace and metric attributes describe.
- [Troubleshooting](./TROUBLESHOOTING.md) — incident workflows that
  reference traces and structured logs.
