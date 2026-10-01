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
- `client` — `client(config, options)`: the SDK's `SemiontClient` over this
  crate's transport under all three contracts, so its `auth` and `system`
  namespaces are there.
- `service_account` and `agent` — a service signing in: its account's
  client-credentials grant at the issuer, exchanged at the gateway for the
  token of the agent the work runs as (`AgentToken`), and renewed before it
  expires. An agent's token is a credential source, as a person's stored
  sign-in is, and not a session: an agent whose renewal fails keeps the
  token it has and tries again, where a person is signed out.

Behind the `sign-in` feature, which a service does not enable, signing a
person in:

- `oauth` — the client as an OAuth public client of the issuer a knowledge
  base trusts: the issuer found from the knowledge base's resource metadata,
  the authorization-code grant with PKCE, the device grant, the refresh
  grant and revocation. A stored session's renewal tells a refusal from an
  outage: only no answer, or one that says "not now", is tried again, inside
  a bounded budget. PKCE's challenge and its random verifier are `ring`'s.
- `session` — sessions over a gateway. `HttpSessionFactory` is what a
  `SemiontBrowser` builds its sessions through; `session_over_http`,
  `session_from_issued` and `sign_in_device` are what a script uses
  directly; `begin_sign_in` and `complete_sign_in` are a registry's sign-in
  through the issuer. Renewals of one knowledge base that are asked for
  together are one request of the issuer. A registry's session resumes its
  stream from the place its storage kept (`Bookmarks`).
- `loopback` — the address an application with no web page of its own is
  sent back to after a sign-in. The issuer sends a person back only to an
  address its registration of the client lists.
- `discovery` — a launcher's discovery document over HTTP.

```rust
// A script signs in as a person: the issuer mints a code, the person
// approves it wherever they have a browser.
let session = sign_in_device(
    SignInDevice { kb, storage, validate: true, on_auth_failed: None, on_error: None, http },
    |code| println!("Open {} and enter {}", code.verification_uri, code.user_code),
)
.await?;
let resource = session.client().browse.resource("res-1").fresh().await?;
```

[conformance/](conformance) holds the two drivers the SDK conformance suite
([tests/conformance/sdk](../../tests/conformance/sdk/README.md)) runs:
`semiont-wire-driver`, in this crate's place, and `semiont-live-driver`, in
the place of the SDK's client over it. [tests/stream.rs](tests/stream.rs) holds the liveness axioms
and the stream's handoffs against a stand-in gateway that misbehaves on cue,
and [tests/sign_in.rs](tests/sign_in.rs) the grants, the sessions and a
registry's sign-in against a stand-in gateway and issuer.

Not yet published.
