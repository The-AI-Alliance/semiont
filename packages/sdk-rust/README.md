# semiont (Rust)

Semiont's Rust SDK: what a client of a knowledge base needs, as
[`specs/`](../../specs/src/openapi.json) states it.

- `types` — the protocol's types, generated from the spec when the crate is
  built: the body of every request and response the API declares (but the
  ones a service only passes through), every schema of the job protocol's
  channels, and what they reach.
- `bus` — a client of the bus over the gateway's HTTP transport: one stream
  for the channels it subscribes to, emits, and requests answered on the
  registry's result and failure channels.
- `session` and `service_account` — signing in: a service account's
  client-credentials grant at the issuer, exchanged at the gateway for the
  token of the agent the work runs as.
- `identity` and `roles` — how a knowledge base names its principals, and the
  realm's roles, held to the shared case tables in `specs/src` (`tests/`).

Not yet published. Its consumers are the Rust services, which is also what
proves it: the dispatcher conformance suite runs against a dispatcher built on
it.
