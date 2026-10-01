# semiont (Rust)

Semiont's Rust SDK: what a client of a knowledge base needs, as
[`specs/`](../../specs/src/openapi.json) states it, over any transport.

- `types` — the protocol's types, generated from the spec when the crate is
  built: the body of every request and response the API declares (but the
  ones a service only passes through), every schema of the job protocol's
  channels, the log settings, and what they reach.
- `transport` — the contract a client needs of the wire: emit with an
  envelope (correlation id, scope), receive frames with the trace they were
  sent under, say which channels it receives, and keep an awaited reply
  deliverable across a reconnect. `semiont-http-transport` implements it over
  a gateway.
- `bus` — a client of the bus over a `Transport`: emits, replies, and requests
  answered on the registry's result and failure channels.
- `bus_log` — `SEMIONT_BUS_LOG`: one grep-able line per frame a process sends
  or receives. Its trace field is read from whatever telemetry the process
  installed (`semiont-observability`).
- `identity` and `roles` — how a knowledge base names its principals, and the
  realm's roles, held to the shared case tables in `specs/src` (`tests/`).

No HTTP and no telemetry library: those are its transport's and the
process's. Not yet published. Its consumers are the Rust services, which is
also what proves it: the dispatcher conformance suite runs against a
dispatcher built on it.
