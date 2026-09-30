# semiont-core (Rust)

What Semiont's Rust services share and no client needs.

- `spec` — the spec each service is built against, embedded and checked when
  it compiles: validators for every component schema, the bus registry and
  its classification, the route-table comparison.
- `types` and `config` — the service-only types generated from the spec (the
  configuration documents, the job record), and reading a configuration
  document from `--config`, validated before it is used.
- `logging`, `telemetry`, `bus_log`, `alloc` — what every service writes about
  itself.
- `nats` (feature `nats`) — reaching the messaging broker. Only a crate that
  implements a broker-backed interface enables it; CI holds the crates that
  must not.

A protocol type it reaches is the SDK's (`semiont::types`): one home for each.
