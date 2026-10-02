# Gateway Logging

The gateway logs structured lines to stdout, which is the container's contract:
`semiont logs` reads the runtime's stream, and anything that ships logs reads
the same. Its code is [src/logging.rs](../src/logging.rs).

## Level and format

- **Level** — `logLevel` in the gateway's configuration document (`error`,
  `warn`, `info`, `http` or `debug`). The launcher writes it from the selected
  environment's `logLevel`, `info` when the environment names none.
- **Format** — `logFormat` in the same document: `json` (one JSON object per
  line) or `simple` (`<timestamp> [LEVEL] message {fields}`, for reading at a
  terminal). The launcher writes `json`.

`SEMIONT_BUS_LOG` lines (`[bus EMIT] …`) and a fatal error's `[fatal] …` go to
stderr, so stdout stays one format.

## What every line carries

- `requestId` — on every line logged while handling a request, and returned to
  the caller as the `X-Request-ID` header, so a client's report finds the
  gateway's lines.
- `trace_id` and `span_id` — when a trace is active and an OpenTelemetry
  exporter is configured, so a line leads to its trace
  ([OBSERVABILITY.md](../../../docs/system/administration/OBSERVABILITY.md)).
- `component` — for lines from a subsystem: `bus`, `signal`,
  `archivist-client`, `event-loop-monitor`.

## What is logged

### Requests (`info`)

One line as a request arrives and one as its response leaves:

```json
{ "level": "info", "message": "Incoming request", "type": "request_incoming", "method": "POST", "path": "/bus/emit", "requestId": "…", "timestamp": "…" }
{ "level": "info", "message": "Outgoing response", "type": "request_outgoing", "method": "POST", "path": "/bus/emit", "status": 202, "durationMs": 4, "requestId": "…", "timestamp": "…" }
```

### Authentication failures (`warn`)

```json
{ "level": "warn", "message": "Authentication failed: Invalid token", "type": "auth_failed", "reason": "invalid_token", "path": "/api/status", "method": "GET", "error": "…", "requestId": "…" }
```

`reason` is `missing_token`, `invalid_token` or `invalid_media_token`. A
successful authentication is logged at `debug`.

A refused request is three lines: this one between its two request lines. A
client retrying a refused credential therefore writes three lines a request,
at whatever rate it retries; `semiont.gateway.unauthenticated` counts the same
refusals by `reason` without the log.

### Unhandled errors (`error`)

Answered with a 500 `ErrorResponse` that carries none of this:

```json
{ "level": "error", "message": "Unhandled error during request processing", "type": "unhandled_error", "during": "…", "error": "…", "requestId": "…" }
```

### The bus (`component: "bus"`)

Every emit (`info`, with channel, scope, subscriber count, clientId and
correlationId), every SSE connection and disconnection with its reason, and a
`warn` for every moment something is lost or refused, each with a greppable
prefix — `[bus CLAIM-CONFLICT]`, `[bus CLAIM-EXPIRED]`, `[bus CLAIM-EVICTED]`,
`[bus CLAIM-READ-FAILED]`, `[bus REPLY-UNCLAIMED]`, `[bus REPLY-RETAIN-FAILED]`,
`[bus UNANSWERABLE]` among them — and the disconnection of a stalled subscriber
(`SSE pending-write overflow`, `SSE replay-buffer overflow`). The broker's
connection is `component: "signal"`: `[signal BROKER-DOWN]`,
`[signal BROKER-RECONNECTED]`, `[signal BROKER-REFUSED]`.

### The runtime (`component: "event-loop-monitor"`)

Every 30 seconds: the mean, 99th-percentile and maximum of how late the runtime
woke a task that slept 10 ms, at `warn` when the 99th percentile passes 100 ms
— the signal that requests are waiting rather than being handled.
