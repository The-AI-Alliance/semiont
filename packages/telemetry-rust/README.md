# semiont-telemetry

[![crates.io](https://img.shields.io/crates/v/semiont-telemetry.svg)](https://crates.io/crates/semiont-telemetry)
[![docs.rs](https://img.shields.io/docsrs/semiont-telemetry)](https://docs.rs/semiont-telemetry)
[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/crates/l/semiont-telemetry.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The traces and counts of the [Semiont Rust SDK](../sdk-rust/README.md), as
[OpenTelemetry](https://opentelemetry.io). When a Semiont client sends to a
knowledge base or receives from it, the transport says so through this
crate, and this crate reports it to whatever OpenTelemetry the application
installed.

It exports nothing itself. With no OpenTelemetry installed, nothing is
recorded and no trace context leaves the process.

## Do you need it?

- **To see the client's traces in your own telemetry**, you install your
  OpenTelemetry as usual. [`semiont-http-transport`](../http-transport-rust/README.md)
  already depends on this crate, so its spans appear with yours. See
  [Turning it on](#turning-it-on).
- **To write a transport** for the SDK, you report through the functions
  below. See [Writing a transport](#writing-a-transport).

```bash
cargo add semiont-telemetry
```

It is built with `opentelemetry` 0.33. Every function is documented on
[docs.rs](https://docs.rs/semiont-telemetry).

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

- The application's `opentelemetry` is the version this crate is built with.
  OpenTelemetry's global registry belongs to one version of its crate: a
  provider installed through another version is one this crate never sees,
  and nothing says so.
- The tracer, the meter and the propagator are taken from
  `opentelemetry::global` at each use, so what is installed after a client
  opened is reported to all the same.
- With a tracer provider and no propagator, spans are recorded and no trace
  context travels.

## What is reported

The spans and the count are the rows of the SDK telemetry table
([telemetry.json](../../specs/src/sdk-telemetry/telemetry.json)), which
every Semiont SDK reports the same way.

| Name | Kind | When |
|---|---|---|
| `bus.emit:{channel}` | producer span | The client sends on a channel |
| `semiont.bus.sent` | counter | The same, counted |
| `bus.recv:{channel}` | consumer span | A frame arrives, continuing the trace it was sent under |
| `content.put` | client span | A resource's bytes are uploaded |
| `content.get` | client span | A resource's bytes are read |
| `content.get_graph` | client span | A resource's linked-data description is read |

A trace travels with what is sent, as the W3C `traceparent` and
`tracestate`, so one request can be followed from the application through
the gateway and the services behind it.

## Writing a transport

One function per row of the table. A transport says what happened, in
Semiont's terms, and names no span, kind or attribute of its own:

| Function | Row |
|---|---|
| `bus_emit(channel, scope, send)` | `bus.emit:{channel}`, and the count |
| `bus_recv(channel, scope, sent_under)` | `bus.recv:{channel}` |
| `content_put(format, size_bytes, upload)` | `content.put` |
| `content_get(resource_id, stream, read)` | `content.get` |
| `content_get_graph(resource_id, read)` | `content.get_graph` |

```rust
// The span's name, its kind and its attributes are the table's.
let created = content_put("image/png", 256, upload).await;
```

`active_trace()` is the trace context of the span that is running, as the
SDK's `TraceCarrier`: what a transport puts on what it sends. `bus_recv`
answers the trace that the work done for a frame continues.

A transport depends on this crate and on no OpenTelemetry crate.

## Writing a service

Semiont's own services state spans of their own, the rows of the service
telemetry table
([telemetry.json](../../specs/src/service-telemetry/telemetry.json)), over
four more functions:

| Function | |
|---|---|
| `in_span`, `in_span_now` | Run work in a span |
| `continued` | A caller's trace, as the parent of what is done for it |
| `continuing` | Run work in the trace a frame arrived in |
| `on_the_bus` | The attributes a span or a count of the bus carries |

## The other crates

| Crate | |
|---|---|
| [`semiont`](../sdk-rust/README.md) | The SDK's client. |
| [`semiont-http-transport`](../http-transport-rust/README.md) | The transport over a gateway, which reports through this crate. |
| [`semiont-codegen`](../codegen-rust/README.md) | The build-time generator of the SDK's types. Cargo builds it for you. |

## Contributing

Both Rust blocks on this page are regions of [tests/on.rs](tests/on.rs),
which runs them in a process that installed an OpenTelemetry of its own and
holds the crate to the telemetry table in both directions.
[tests/off.rs](tests/off.rs) is the process that installed none.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
