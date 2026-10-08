# semiont-http-transport

[![crates.io](https://img.shields.io/crates/v/semiont-http-transport.svg)](https://crates.io/crates/semiont-http-transport)
[![docs.rs](https://img.shields.io/docsrs/semiont-http-transport)](https://docs.rs/semiont-http-transport)
[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/crates/l/semiont-http-transport.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The HTTP transport of the [Semiont Rust SDK](../sdk-rust/README.md). It
connects a [`semiont`](https://crates.io/crates/semiont) client to a
knowledge base's gateway, and signs in the person or the service that uses
it.

[Semiont](../../README.md) is an open platform for building trusted AI
knowledge bases. The SDK's client does no networking of its own: this crate
is how it reaches a knowledge base. Start with the
[SDK's README](../sdk-rust/README.md) for what the client does, and come
here for how to connect it.

## Install

```bash
cargo add semiont
cargo add semiont-http-transport --features sign-in
```

| Feature | What it adds |
|---|---|
| `sign-in` | Signing a person in, and their sessions: the issuer's grants, the redirect back to this machine, and the launcher's stored sign-in. A service signs in as its own account and leaves the feature off. |

It is used inside a [Tokio](https://tokio.rs) runtime. Every type and
function is documented on
[docs.rs](https://docs.rs/semiont-http-transport).

### TLS

The crate sends with a `reqwest::Client` the application gives it, the `http`
of every example below. It turns on none of `reqwest`'s TLS features itself:
which TLS library carries the connection is the application's choice. An
application that reaches a gateway over `https` adds `reqwest` at the version
this crate is built with, 0.13, with a TLS feature. Semiont's own services
use rustls with the `ring` provider:

```toml
[dependencies]
reqwest = { version = "0.13", default-features = false, features = ["rustls-no-provider"] }
rustls = { version = "0.23", default-features = false, features = ["ring", "std"] }
```

With `rustls-no-provider`, the process installs the provider once, before it
builds a client: `rustls::crypto::ring::default_provider().install_default()`.

## Signing in

A person signs in at the identity provider the knowledge base trusts, never
at the gateway, and their password never passes through the process. A
service signs in with an account of its own. Which way fits depends on the
program, a script, a daemon or an application, as in the SDK's
[three ways to use the client](../sdk-rust/README.md#three-ways-to-use-it).

| Who | Signs in with | Gives |
|---|---|---|
| A script, after `semiont login` | `session_from_stored` | a `SemiontSession` |
| A script on its own | `sign_in_device` | a `SemiontSession` |
| A daemon | `AgentToken::sign_in`, then `client` | a `SemiontClient` |
| An application | `begin_sign_in`, `complete_sign_in` | a session in its `SemiontBrowser` |

In the examples:

- `http` is the application's `reqwest::Client`.
- `gateway` is where the knowledge base's gateway is: an `HttpEndpoint`
  (host, port and protocol), or its origin as text for a daemon.
- `kb` is a `KbTarget`: a knowledge base's id, its name and its endpoint.
- `storage` is an `Arc<dyn SessionStorage>`: where a session's tokens are
  kept.

### A script, after `semiont login`

The [launcher](../../apps/launcher/README.md)'s `semiont login` signs a
person in and keeps the sign-in on disk
([sign-in store](../../specs/src/sign-in-store/README.md)). A script reuses
it. `state_home` is the directory that holds it:
`semiont::sign_in_store::state_dir` of what the script read of its own
environment. The crates read none themselves.

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

### A script on its own

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

### A daemon

A daemon signs in as a service, and its work runs as an agent. `credential`
is its service account at the issuer: the issuer, a client id and a client
secret. It is not a session: an agent whose renewal fails keeps the token it
has and tries again, where a person would be signed out.

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

`HttpTransportConfig` is everything a transport is given:

| Field | |
|---|---|
| `base_url` | The gateway's origin. |
| `token` | The token every request carries: the current one, and each one after it. With none, the transport sends nothing and waits for one. |
| `refresher` | Asked for a new token when the gateway answers 401. |
| `channels` | The global channels the stream names. `None` is every channel a client hears. A process that awaits only some operations names their reply channels, and is not sent every other client's replies. |
| `http` | The application's `reqwest::Client`. |
| `timing` | The deadlines. `Timing::default()` is the ones every Semiont SDK keeps. |
| `bookmarks` | Where the stream's place is kept across restarts. With none, the stream begins each life at the present. |

**A worker** is a daemon whose agent claims jobs from the knowledge base's
queue. Its stream names `JOB_CLAIM_CHANNELS`, and the client's `job.claim`
hands it each job it comes to hold.

```rust
// A worker signs in as a daemon does: with its service account, as the
// agent its work is attributed to.
let agent = AgentToken::sign_in(
    gateway,
    Agent {
        provider: "ollama".to_owned(),
        model: "gemma3:4b".to_owned(),
    },
    ServiceToken::new(credential, http.clone()),
    http.clone(),
)
.await?;
println!("working as {}", agent.did());
let client = client(
    HttpTransportConfig {
        base_url: agent.gateway().to_owned(),
        token: agent.token(),
        refresher: Some(agent.clone()),
        // Its stream names what claiming reads. This worker awaits
        // nothing else, so it names nothing else.
        channels: Some(JOB_CLAIM_CHANNELS.map(str::to_owned).to_vec()),
        http,
        timing: Timing::default(),
        bookmarks: None,
    },
    ClientOptions::default(),
);

// What it accepts: the `mark` jobs of one motivation.
let highlighting = MarkJobFilter::new(MarkJobFilterParams {
    motivation: Motivation::Highlighting,
});
let claims = client
    .job
    .claim(ClaimOptions::new(vec![highlighting.into()]));

// Each job the worker comes to hold, one at a time. The next is claimed
// when this one settles.
while let Some(handed) = claims.next().await {
    match handed {
        Ok(HeldJob::Mark(job)) => {
            job.start().await?;
            // Your work: read the resource, find the passages, commit them.
            job.progress(JobProgress::new(50.0)).await?;
            let result = JobDetectionResult::new(0, 0);
            // A settle takes the job, so it cannot be settled twice. A
            // job dropped unsettled is failed, and the queue retries it.
            job.complete(result.into(), None).await?;
        }
        Ok(HeldJob::Yield(job)) => {
            let never = JobFailure {
                failure_class: Some(FailureClass::Deterministic),
                ..JobFailure::default()
            };
            job.fail("this worker runs no yield job", never).await?;
        }
        Err(refusal) => {
            eprintln!("claim refused: {}", refusal.message);
            // This credential can never claim. Stop, so that whoever
            // runs the worker sees it.
            if refusal.code == Some(BusRequestErrorCode::Unauthorized) {
                break;
            }
        }
    }
}
// Stopping fails a job the worker still holds.
claims.stop().await;
```

The service account needs two roles at the issuer: `semiont-service`, to be
given an agent, and `semiont-worker`, without which every claim is refused.
What claiming does, and what a held job is, are in the SDK's
[A worker](../sdk-rust/README.md#a-worker).

### An application

An application holds a `SemiontBrowser` whose sessions are built by
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

The issuer sends a person back only to an address its registration of the
client lists. The realm a Semiont launcher sets up lists the loopback
address for the browser client, at any port. What an issuer of your own has
to provide is in
[Authentication](../../docs/operator/administration/AUTHENTICATION.md).

## What it implements

The SDK states three contracts a client needs of the wire
(`semiont::transport`), and this crate implements each over a gateway
([HTTP transport](../../docs/protocol/TRANSPORT-HTTP.md),
[transport contract](../../docs/protocol/TRANSPORT-CONTRACT.md)):

| Contract | Type here | Carries |
|---|---|---|
| `Transport` | `HttpTransport` | The bus: what the client sends, and the one stream of what it receives |
| `ContentTransport` | `HttpContentTransport` | A resource's bytes, up and down |
| `GatewayOperations` | `HttpTransport` | The gateway's plain operations: who a token is, which issuer the knowledge base trusts, its health and status |

`client(config, options)` is the SDK's `SemiontClient` over all three, so
its `auth` and `system` namespaces are there.

## How it behaves

- **One stream.** Everything a client receives arrives on one stream. It is
  opened when first needed. When what it carries changes, a new one is
  opened and the old one is read until the new one is ready, so nothing is
  missed between them.
- **A dropped stream is reopened** from where each resource's events had got
  to, with the replies still awaited. Each event is delivered once.
- **A refused token closes the stream** until a new one arrives. The
  `refresher` is asked once per outage.
- **A request has a deadline** (`Timing::http_request`). Unanswered by then,
  it fails as one that got no answer, and is not made again.
- **Content.** An upload reports its progress and can be cancelled. It has
  no deadline, since how long it takes is how large the resource is. A
  download's deadline is on the bytes beginning to arrive.
- **A person's renewal tells a refusal from an outage.** Only no answer, or
  one that says "not now", is tried again, inside a bounded budget. A
  refusal ends the session.

## Telemetry

Each emit and each content request runs in a span, and each frame received
is delivered with the trace it was sent under. The spans are made by
[`semiont-telemetry`](../telemetry-rust/README.md) and reported to whatever
OpenTelemetry the application installed. Its README says how to turn that
on. With none installed, nothing is recorded and no `traceparent` is sent.

With `SEMIONT_BUS_LOG` set, each emit and each frame received is also a line
on stderr.

## What is in the crate

| Module | What it holds |
|---|---|
| `client` | `client(config, options)`: a `SemiontClient` over this transport |
| `transport` | `HttpTransport`, `HttpTransportConfig`, `Timing`, `Bookmarks` |
| `content` | `HttpContentTransport` |
| `service_account`, `agent` | A service's sign-in: `Credential`, `ServiceToken`, `AgentToken` |
| `session` (`sign-in`) | Sessions over a gateway: `session_from_stored`, `sign_in_device`, `begin_sign_in`, `complete_sign_in`, `HttpSessionFactory` |
| `oauth` (`sign-in`) | The issuer's grants: authorization code with PKCE, device, refresh, and revocation |
| `loopback` (`sign-in`) | `LoopbackRedirect`: the address on this machine a person is sent back to |
| `discovery` (`sign-in`) | A launcher's list of knowledge bases, read over HTTP |

## The other crates

| Crate | |
|---|---|
| [`semiont`](../sdk-rust/README.md) | The client this crate carries, and the contracts it implements. |
| [`semiont-telemetry`](../telemetry-rust/README.md) | The spans and counts this crate reports, and how an application turns tracing on. |
| [`semiont-codegen`](../codegen-rust/README.md) | The build-time generator of the SDK's types. Cargo builds it for you. |

## Contributing

Every Rust block on this page is a region of
[tests/sign_in.rs](tests/sign_in.rs), compiled and run there against a
stand-in gateway and issuer. The Rust block of the
[`semiont-worker` skill](../../docs/builder/skills/semiont-worker/SKILL.md)
is held to the same regions. [tests/stream.rs](tests/stream.rs) holds the
stream's behaviour against a gateway that misbehaves on cue.
[conformance/](conformance) holds the two drivers the
[SDK conformance suite](../../tests/conformance/sdk/README.md) runs, and the
one the [worker conformance suite](../../tests/conformance/worker/README.md)
runs.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
