# semiont-http-transport (Rust)

A knowledge base over its gateway's HTTP surface
([TRANSPORT-HTTP.md](../../docs/protocol/TRANSPORT-HTTP.md)), as the SDK's
`Transport`, `ContentTransport` and `GatewayOperations`
(`semiont::transport`), to the contract every SDK's transport is held to
([TRANSPORT-CONTRACT.md](../../docs/protocol/TRANSPORT-CONTRACT.md)).

- `transport` — `HttpTransport`: `POST /bus/emit` for what it sends, and the
  gateway's plain operations. Each emit is logged (`[bus EMIT]`), counted
  (`semiont.bus.sent`) and sent in a `bus.emit` span whose trace travels as
  `traceparent`; each frame received is logged (`[bus RECV]`) and delivered
  with the trace it carried.
- `actor` — the one stream, `POST /bus/subscribe`, and its state: opened when
  first needed; replaced without a gap when what it carries changes, the old
  one read until the new one is open; reopened after a drop from where each
  scope had got to, with the replies still awaited; each event delivered once;
  and held shut while the token is refused, until a new one arrives.
- `sse` — the stream's framing.
- `content` — `HttpContentTransport`: a resource's bytes up, with progress
  and cancellation, and down, whole or as a stream.
- `client` — `client(config, timing)`: the SDK's `SemiontClient` over this
  crate's transport under all three contracts, so its `auth` and `system`
  namespaces are there.
- `service_account` and `session` — signing in: a service account's
  client-credentials grant at the issuer, exchanged at the gateway for the
  token of the agent the work runs as, and renewed before it expires.

[conformance/](conformance) is the wire driver the SDK conformance suite
([tests/conformance/sdk](../../tests/conformance/sdk/README.md)) runs in this
crate's place; [tests/stream.rs](tests/stream.rs) holds the liveness axioms
and the stream's handoffs against a stand-in gateway that misbehaves on cue.

Not yet published.
