# semiont-http-transport (Rust)

A knowledge base's bus over its gateway's HTTP surface
([TRANSPORT-HTTP.md](../../docs/protocol/TRANSPORT-HTTP.md)), as the SDK's
`Transport` (`semiont::transport`).

- `transport` — `HttpTransport`: one stream, `POST /bus/subscribe`, held open
  for as long as the transport lives and reopened with the replies still
  awaited, and `POST /bus/emit` for what it sends. Each emit is logged
  (`[bus EMIT]`), counted (`semiont.bus.sent`) and sent in a `bus.emit` span
  whose trace travels as `traceparent`; each frame received is logged
  (`[bus RECV]`) and delivered with the trace it carried.
- `service_account` and `session` — signing in: a service account's
  client-credentials grant at the issuer, exchanged at the gateway for the
  token of the agent the work runs as.

Not yet published.
