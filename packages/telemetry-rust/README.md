# semiont-telemetry (Rust)

The telemetry every Semiont transport and service shares: the spans and the
count of the SDK telemetry table
([sdk-telemetry/telemetry.json](../../specs/src/sdk-telemetry/telemetry.json)),
and the trace context they travel in. It exports nothing. It reports to
whatever OpenTelemetry the process installed, and with none installed it
records nothing and no trace context leaves the process.

## What a transport calls

One function per row of the table. A transport says what happened, in
Semiont's terms, and names no span, kind or attribute of its own:

| Function | Row | Kind |
|---|---|---|
| `bus_emit(channel, scope, send)` | `bus.emit:{channel}`, and the count `semiont.bus.sent` | producer span, counter |
| `bus_recv(channel, scope, sent_under)` | `bus.recv:{channel}`, continuing the trace the frame was sent under | consumer span |
| `content_put(format, size_bytes, upload)` | `content.put` | client span |
| `content_get(resource_id, stream, read)` | `content.get` | client span |
| `content_get_graph(resource_id, read)` | `content.get_graph` | client span |

```rust
// The span's name, its kind and its attributes are the table's.
let created = content_put("image/png", 256, upload).await;
```

`active_trace()` is the W3C trace context of the span that is running, as the
SDK's `TraceCarrier`: what a transport puts on what it sends (`traceparent`,
`tracestate`). `bus_recv` answers the trace that what is done for the frame
continues.

A transport depends on this crate and on no OpenTelemetry crate: CI fails
`semiont-http-transport` if it lists one, fails either crate if it links an
exporter or the OpenTelemetry SDK, and fails this one if it links an HTTP
client: it is every transport's, and is none.

## What a service calls

A service's own spans are the service telemetry table's
([service-telemetry/telemetry.json](../../specs/src/service-telemetry/telemetry.json)),
which it states itself, in OpenTelemetry's types: `in_span` and `in_span_now`
run work in a span, `continued` is a caller's trace as the parent of what is
done for it, `continuing` runs work in the trace a frame arrived in, and
`on_the_bus` is the attributes a span or a count of the bus carries.

## Turning it on

An application installs its own OpenTelemetry as the process's, once:

```rust
// A tracer provider, a meter provider and the W3C propagator, as the
// process's: what this crate, and so the transport, reports to.
global::set_text_map_propagator(TraceContextPropagator::new());
global::set_tracer_provider(tracer_provider);
global::set_meter_provider(meter_provider.clone());
// The bus log's `trace=` field is the active span's trace.
semiont::bus_log::set_trace_id_provider(semiont_telemetry::active_trace_id);
```

- The tracer, the meter and the propagator are taken from
  `opentelemetry::global` at each use, so what is installed after a client
  opened is reported to all the same.
- The application's `opentelemetry` is the version this crate is built with.
  OpenTelemetry's global registry belongs to one version of its crate: a
  provider installed through another version is one this crate never sees,
  and nothing says so.
- With a tracer provider and no propagator, spans are recorded and no trace
  context travels.

Semiont's own services install theirs with `semiont-observability`, which
also exports it.

## Tests

[tests/on.rs](tests/on.rs) reads the SDK telemetry table and holds the crate
to it in both directions, in a process that installed an OpenTelemetry of its
own: a row with no function fails, and so does a span, a kind or an attribute
the table does not list. The examples above are regions of that file, run
there. [tests/off.rs](tests/off.rs) is the process that installed none. The
SDK conformance suite holds what a transport exports to the same table from
outside ([tests/conformance/sdk](../../tests/conformance/sdk/README.md)).

Not yet published.
