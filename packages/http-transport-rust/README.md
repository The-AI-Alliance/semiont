# semiont-http-transport (Rust)

A knowledge base over its gateway's HTTP surface
([TRANSPORT-HTTP.md](../../docs/protocol/TRANSPORT-HTTP.md)), as the SDK's
`Transport`, `ContentTransport` and `GatewayOperations`
(`semiont::transport`), to the contract every SDK's transport is held to
([TRANSPORT-CONTRACT.md](../../docs/protocol/TRANSPORT-CONTRACT.md)).

- `transport` — `HttpTransport`: `POST /bus/emit` for what it sends, and the
  gateway's plain operations. A request that is neither the stream nor an
  emit has the deadline every SDK keeps (`HTTP_REQUEST_TIMEOUT`, or
  `Timing::http_request`): unanswered by then, it fails as one that got no
  answer and is not made again. Each emit is logged (`[bus EMIT]`), counted
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
  and cancellation, and down, whole or as a stream. The deadline is on the
  bytes beginning to arrive; an upload has none, since how long it takes is
  how large the resource is.
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
  a bounded budget. Every request to the issuer has the same deadline, and
  one that passes it is one that got no answer. PKCE's challenge and its
  random verifier are `ring`'s.
- `session` — sessions over a gateway. `HttpSessionFactory` is what a
  `SemiontBrowser` builds its sessions through; `session_from_stored` (a
  sign-in a storage already holds), `sign_in_device`, `session_from_issued`
  and `session_over_http` are what a script uses directly; `begin_sign_in` and `complete_sign_in` are a registry's sign-in
  through the issuer. Renewals of one knowledge base that are asked for
  together are one request of the issuer. A registry's session resumes its
  stream from the place its storage kept (`Bookmarks`).
- `loopback` — the address an application with no web page of its own is
  sent back to after a sign-in. The issuer sends a person back only to an
  address its registration of the client lists; the realm a Semiont
  launcher renders lists the loopback address for the browser client, at
  any port.
- `discovery` — a launcher's discovery document over HTTP.

## Three ways to use it

These are the SDK's [three ways](../sdk-rust/README.md#three-ways-to-use-it),
from the side of how each is signed in.

**A script** uses the sign-in `semiont login` made
([sign-in-store](../../specs/src/sign-in-store/README.md)). `state_home` is
`semiont::sign_in_store::state_dir` of what the script read of its
environment: the crates read none themselves.

```rust
// The sign-in `semiont login` made for the local stack. The stack's key
// is the knowledge base's id.
let store = SignInStore::at(
    state_home.join(FILE_NAME),
    Arc::new(InMemorySessionStorage::new()),
    Arc::new(|why| eprintln!("{why}")),
);
let session = session_from_stored(StoredSignIn {
    kb: KbTarget::http(
        "local",
        "Local",
        &gateway.host,
        gateway.port,
        gateway.protocol,
    ),
    storage: Arc::new(store),
    base_url: gateway.gateway_url()?,
    validate: true,
    on_auth_failed: None,
    on_error: None,
    http,
})
.await
.ok_or("Not signed in. Run `semiont login`.")?;

let about = session.client().browse.kb().await?;
session.close().await;
```

Where nobody has signed in, a script signs a person in by the device grant
and keeps the tokens in the storage it is given.

```rust
// The issuer mints a code, and the person approves it wherever they
// have a browser. No password passes through this process.
let session = sign_in_device(
    SignInDevice {
        kb,
        storage,
        validate: true,
        on_auth_failed: None,
        on_error: None,
        http,
    },
    |code| {
        println!(
            "Open {} and enter {}",
            code.verification_uri, code.user_code
        )
    },
)
.await?;
```

**A daemon** signs in as a service, and its work runs as an agent. It is not
a session: an agent whose renewal fails keeps the token it has and tries
again.

```rust
// A service signs in with its account, as the agent its work runs as,
// and stays signed in for as long as it holds the token.
let agent = AgentToken::sign_in(
    gateway,
    Agent {
        provider: "example".to_owned(),
        model: "indexer".to_owned(),
    },
    ServiceToken::new(credential, http.clone()),
    http.clone(),
)
.await?;
let client = client(
    HttpTransportConfig {
        base_url: agent.gateway().to_owned(),
        token: agent.token(),
        refresher: Some(agent.clone()),
        channels: None,
        http,
        timing: Timing::default(),
        bookmarks: None,
    },
    ClientOptions::default(),
);

// Every job that completes, from now on.
let mut completed = client.job.complete();
while let Some(event) = completed.next().await {
    if let Ok(job) = event {
        done(job.payload);
    }
}
```

**An application** holds a `SemiontBrowser` whose sessions are built by
`HttpSessionFactory`, and signs a person in at the issuer through a redirect
to this machine. `open` shows the person the URL.

```rust
// The registry an application holds, with its sessions over HTTP.
let browser = SemiontBrowser::new(SemiontBrowserConfig {
    storage,
    session_factory: Arc::new(HttpSessionFactory::new(http.clone())),
});

// A person signs in at the issuer the knowledge base trusts, in their
// own browser, and is sent back to a port on this machine.
let redirect = LoopbackRedirect::bind().await?;
let url = begin_sign_in(
    &browser,
    BeginAuthorization {
        target: gateway,
        redirect_uri: redirect.redirect_uri(),
        kb_id: None,
        expected_did: None,
        expected_name: None,
    },
    &http,
)
.await?;
open(&url);
let callback = redirect.callback().await?;

// The knowledge base that answered is registered, signed in and active.
let signed_in = complete_sign_in(&browser, &callback, &http).await?;
```

[conformance/](conformance) holds the two drivers the SDK conformance suite
([tests/conformance/sdk](../../tests/conformance/sdk/README.md)) runs:
`semiont-wire-driver`, in this crate's place, and `semiont-live-driver`, in
the place of the SDK's client over it. [tests/stream.rs](tests/stream.rs) holds the liveness axioms
and the stream's handoffs against a stand-in gateway that misbehaves on cue,
and [tests/sign_in.rs](tests/sign_in.rs) the grants, the sessions and a
registry's sign-in against a stand-in gateway and issuer. The examples above
are regions of that file, run there: a block here that is not one of them
fails a test.

Not yet published.
