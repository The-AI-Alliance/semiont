# semiont (Rust)

Semiont's Rust SDK: a client of a knowledge base, as
[`specs/`](../../specs/src/openapi.json) states it, over any transport.

```rust
use semiont::types::Motivation;

// A client over a gateway is `semiont_http_transport::client::client`.
let resource = client.browse.resource("res-1").fresh().await?;
let annotations = client.browse.annotations("res-1").fresh().await?;

// A long-running operation is awaited for its final value, or read as a
// stream for what it reports on the way.
let mut assist = client.mark.assist("res-1", Motivation::Highlighting, Default::default());
while let Some(event) = assist.next().await {
    println!("{:?}", event?);
}
client.close().await;
```

- `client` — `SemiontClient`: one concrete type over a `Transport`, a
  `ContentTransport` and, when there is one, a gateway. Its namespaces are
  fields: `frame`, `browse`, `mark`, `bind`, `gather`, `match_`, `yield_`,
  `beckon`, `job`, and `auth` and `system` when it has a gateway. `yield` and
  `match` are Rust's own words, so those two take a trailing underscore.
  `close` is the graceful end; a client that is only dropped ends its own bus.
- `namespaces` — the methods. Each one's name, the shape of what it returns
  and what calling it does are a row of
  [`specs/src/client/surface.json`](../../specs/src/client/surface.json),
  which every SDK is held to: `lint:client-surface` reads the signatures,
  and [tests/surface.rs](tests/surface.rs) runs the table's cases.

  | A method that returns | is | used as |
  |---|---|---|
  | `async fn … -> Result<T, SemiontError>` | asked once, answered once | `.await?` |
  | `Running<T>` | a long-running operation | `.await` for its final value; `.next()` for each report and then the final value; `.run(f)` for both |
  | `Upload` | an upload in flight | `.await` for the resource created; as a stream, its progress; dropped, cancelled |
  | `Cached<T>` | a query, built without touching the wire | `.fresh().await?` |
  | nothing, from a plain `fn` | a signal to the client's own parts | called |
  | `async fn … -> Result<Option<u64>, SemiontError>` | a drive at the other participants | `.await?`: how many the gateway reached, `None` when it kept no count |
  | `Typed<C, BusFrames>` | one channel's events, from now on | `.next()` |

  A `Running` and an `Upload` are consumed by value, so one operation is
  never started twice; nothing is sent until one is first polled, and
  dropping one abandons it.

  Two things differ from the TypeScript client. `browse.resource_content`
  decodes UTF-8 and refuses any other charset by name;
  `browse.resource_representation` gives the bytes. And `yield_` has no
  `create_from_token`: a clone's format and stored name come from a
  media-type registry only TypeScript has, which the table records.
- `running` and `cached` — those two shapes.
- `types` — the protocol's types, generated from the spec when the crate is
  built: the body of every request and response the API declares (but the
  ones a service only passes through), every schema the bus's channels carry,
  the job protocol's, the log settings, and what they reach.
- `channels` — the bus registry, generated: a type per channel, naming its
  payload, and per operation, naming its reply. A channel that is not in the
  registry, or a payload that is not that channel's, does not compile.
- `errors` and `timing` — the failure codes and the client timing every SDK
  shares, generated from `specs/src/errors` and `specs/src/client`. A
  `SemiontError` is a bus request's failure, the transport's, or a followed
  job's (`job.failed`, `job.stalled`), and `.code()` is the shared code.
- `transport` — the contract a client needs of the wire: emit with an
  envelope (correlation id, scope), receive frames with the trace they were
  sent under, say which channels it receives, hold a resource's scope, report
  its connection's state, and keep an awaited reply deliverable across a
  reconnect, apart from its channel's other traffic. `ContentTransport` and
  `GatewayOperations` are the same for content and for the gateway's plain
  operations. `semiont-http-transport` implements them over a gateway.
- `bus` — a client of the bus over a `Transport`: typed emits, streams and
  requests, answered on the registry's result and failure channels or failed
  under a shared code.
- `event_bus` — a client's own bus, for what never leaves the process.
- `state_unit` — the unit a client's live state is built from: a current
  value, read or watched, that ends when it is closed or dropped.
- `retry` and `session` — when a failure is worth another attempt and when a
  token is renewed, held to the shared case tables in `specs/src` (`tests/`).
- `bus_log` — `SEMIONT_BUS_LOG`: one grep-able line per frame a process sends
  or receives. Its trace field is read from whatever telemetry the process
  installed (`semiont-observability`).
- `identity` and `roles` — how a knowledge base names its principals, and the
  realm's roles, held to the shared case tables too.
- `testing`, behind the `testing` feature — `FaultyTransport`, a transport
  that fails as a test scripts it and refuses an operation nobody scripted;
  `InMemoryContent`, which keeps what is uploaded and fails a read of what
  nobody stored; `StubGateway`, which answers only what it was told to; and
  the harnesses for the state-unit axioms and the liveness axioms (generated
  schedules of faults), which a transport's own tests run too.

A stream of events says when it fell behind (`Lagged`) instead of dropping
frames silently. No HTTP and no telemetry library: those are its transport's
and the process's, and CI fails if the crate links either. Not yet published.
Its consumers are the Rust services, which is also what proves it: the
dispatcher conformance suite runs against a dispatcher built on it.
