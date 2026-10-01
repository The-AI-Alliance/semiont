# semiont (Rust)

Semiont's Rust SDK: what a client of a knowledge base needs, as
[`specs/`](../../specs/src/openapi.json) states it, over any transport.

- `types` — the protocol's types, generated from the spec when the crate is
  built: the body of every request and response the API declares (but the
  ones a service only passes through), every schema the bus's channels carry,
  the job protocol's, the log settings, and what they reach.
- `channels` — the bus registry, generated: a type per channel, naming its
  payload, and per operation, naming its reply. A channel that is not in the
  registry, or a payload that is not that channel's, does not compile.
- `errors` and `timing` — the failure codes and the client timing every SDK
  shares, generated from `specs/src/errors` and `specs/src/client`.
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
  and the harnesses for the state-unit axioms and the liveness axioms
  (generated schedules of faults), which a transport's own tests run too.

A stream of events says when it fell behind (`Lagged`) instead of dropping
frames silently. No HTTP and no telemetry library: those are its transport's
and the process's, and CI fails if the crate links either. Not yet published.
Its consumers are the Rust services, which is also what proves it: the
dispatcher conformance suite runs against a dispatcher built on it.
