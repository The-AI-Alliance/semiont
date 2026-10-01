# semiont (Rust)

Semiont's Rust SDK: a client of a knowledge base, as
[`specs/`](../../specs/src/openapi.json) states it, over any transport.

```rust
use semiont::state::MarkStateUnit;
use semiont::types::Motivation;

// A client over a gateway is `semiont_http_transport::client::client`.
let resource = client.browse.resource("res-1").fresh().await?;

// A query is watched for its state as the knowledge base changes.
let mut annotations = client.browse.annotations("res-1").watch();
while let Some(state) = annotations.next().await {
    println!("{state:?}"); // Pending, then Ready(…), again on each change
}

// A long-running operation is awaited for its final value, or read as a
// stream for what it reports on the way.
let mut assist = client.mark.assist("res-1", Motivation::Highlighting, Default::default());
while let Some(event) = assist.next().await {
    println!("{:?}", event?);
}

// A flow is held as state by a unit over the client, which it is given as
// an `Arc`: here, the annotation being composed on a resource.
let marking = MarkStateUnit::new(client.clone(), "res-1");
let mut pending = marking.pending();
while pending.changed().await.is_ok() {
    println!("{:?}", *pending.borrow_and_update());
}
client.close().await;
```

- `client` — `SemiontClient`: one concrete type over a `Transport`, a
  `ContentTransport` and, when there is one, a gateway. It is built inside a
  Tokio runtime. Its namespaces are
  fields: `frame`, `browse`, `mark`, `bind`, `gather`, `match_`, `yield_`,
  `beckon`, `job`, and `auth` and `system` when it has a gateway. `yield` and
  `match` are Rust's own words, so those two take a trailing underscore.
  `close` is the graceful end; a client that is only dropped ends its
  queries and its own bus. With `ClientOptions::cache_persistence`, its small
  caches are kept in a `SessionStorage`, and the next client for the same
  knowledge base shows them at once.
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
  | `Cached<T>` | a query, built without touching the wire | `.watch()` for its state now and as it changes; `.fresh().await?` for a one-shot read; `.invalidate()` to ask again |
  | nothing, from a plain `fn` | a signal to the client's own parts | called |
  | `async fn … -> Result<Option<u64>, SemiontError>` | a drive at the other participants | `.await?`: how many the gateway reached, `None` when it kept no count |
  | `Typed<C, BusFrames>` | one channel's events, from now on | `.next()` |

  A `Running` and an `Upload` are consumed by value, so one operation is
  never started twice; nothing is sent until one is first polled, and
  dropping one abandons it.

  A watched query (`Observed<T>`) gives `CacheState<T>`: `Pending`,
  `Ready(value)` or `Failed(error)`. `Failed` is a state, not the end of the
  stream: the next watcher, or `invalidate`, tries again. While a query of
  one resource is watched the client holds that resource's scope, and lets
  go of it when the watcher is dropped. A watcher that falls behind is given
  the latest state, not each one it missed.

  Two things differ from the TypeScript client. `browse.resource_content`
  decodes UTF-8 and refuses any other charset by name;
  `browse.resource_representation` gives the bytes. And `yield_` has no
  `create_from_token`: a clone's format and stored name come from a
  media-type registry only TypeScript has, which the table records.
- `running` and `cached` — those two shapes.
- `cache` — what the queries answer from
  ([CACHE-SEMANTICS](../sdk/docs/CACHE-SEMANTICS.md)): one state per key, the
  same for every observer; a value shown while a newer one is fetched; one
  retry of a failed fetch; `set` and `remove` for what an event already
  says. `CachePersister` keeps a cache's values for a later one, and
  `StoragePersister` is that over a `SessionStorage`.
- `refresh` — what each event on the bus, and the reopening of a dropped
  stream, does to the cache, generated from
  [`specs/src/client/refresh.json`](../../specs/src/client/refresh.json).
  `browse` applies it. A row added there with nothing here that reads its
  event does not compile.
- `storage` — `SessionStorage`, where a client keeps what must outlive it,
  and `InMemorySessionStorage`. More than one context can write a store, so
  what is written from what was read goes through `update`, which a store
  makes one step.
- `resume` — the stream's place in each scope, kept so the next client for
  the same knowledge base resumes from it. It is written with the caches'
  own writes and only when they are at rest, so it can lag what the caches
  hold and never leads it.
- `session` — sessions with knowledge bases.
  - `SemiontSession` is one session: a client, the token its transport
    sends, and who is signed in. It is given how to renew its token and how
    to ask who a token is; it renews before the token expires, by the
    schedule every Semiont client keeps, and when the gateway refuses it. A
    session that cannot be renewed clears its token and what it stored, and
    says so once. One that never had a credential is only signed out.
  - `SemiontBrowser` is what an application holds: the knowledge bases it
    has registered, which is active, the active one's session, and what a
    person has open in each. One session is live at a time. A sign-in lands
    on the entry, among those at its address, whose did is the one the
    knowledge base reported, or on a new entry: an entry's did never
    changes. When a session comes up the knowledge base is asked who it is
    and each open resource is checked against it; only a resource the
    knowledge base says is gone is closed, and a different knowledge base
    answering voids what was open and is raised for a host to show.
  - `SessionSignals` is what a host shows about a session: that it expired,
    that a request was refused for lack of permission, that a different
    knowledge base is answering.
  - `SessionFactory` builds a knowledge base's session and ends its
    credentials. A browser is given one, and so knows nothing of how a
    knowledge base is reached. `semiont-http-transport` has the one over a
    gateway, and signing in at an issuer.

  ```rust
  let browser = SemiontBrowser::new(SemiontBrowserConfig { storage, session_factory });
  let mut session = browser.active_session();
  while session.changed().await.is_ok() {
      if let Some(session) = session.borrow_and_update().clone() {
          let marking = MarkStateUnit::new(session.client().clone(), "res-1");
      }
  }
  ```

  A state unit is built over a session's client. A new session has a new
  client, so a unit lasts as long as the session it was built from.
- `sign_in_store` — the sign-ins `semiont login` keeps
  ([specs/src/sign-in-store](../../specs/src/sign-in-store/README.md)), as a
  `SessionStorage`: one sign-in serves the launcher's verbs and an
  application built on this SDK. A session reaches a stack's sign-in by
  using the stack's key (`local`, `codespace:<owner>/<name>`) as its
  knowledge base id. Every change to the file is made under a lock beside
  it. The crate reads no environment: the application says where its state
  home is (`state_dir`).
- `discovery` — the knowledge bases a launcher manages
  ([specs/src/discovery](../../specs/src/discovery/README.md)): its document
  read whole or not at all, and what changed between two readings. Absent
  ("no launcher was found") is not empty ("it manages nothing").
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
  Beside it: `SessionError`, what makes a session unusable; `SignInError`,
  what keeps a person from being signed in; and `IdentityUnverifiable`, a
  knowledge base that could not say who it is.
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
- `event_bus` — a client's own bus, for what never leaves the process. A
  view of one channel gives its frames in order; `frames_among` is one view
  of several channels, for a reader that needs what was said in the order it
  was said.
- `state` — the flows, held as state. A unit is built over an
  `Arc<SemiontClient>` it never closes, listens to the client's own bus from
  the moment it exists, and is read through `tokio::sync::watch` receivers:
  the value now, and each value after it. `dispose` ends it, and so does
  dropping it.

  | Unit | holds | hears, or is told |
  |---|---|---|
  | `MarkStateUnit` (one resource) | the annotation being composed; the motivation and progress of the assist running | `client.mark.request`, `submit`, `cancel_pending`, `request_assist`, `dismiss_progress`; `mark:select-*` and `mark:delete` on the client's bus |
  | `GatherStateUnit` (one resource) | an annotation's context, and a resource's, each with its loading and its failure | `gather:requested` on the client's bus; `gather_resource` |
  | `MatchStateUnit` | nothing: it answers on the bus, under the asker's correlation id | `client.match_.request_search` |
  | `YieldStateUnit` | whether a generation runs, its progress, and what it produced | `generate`, `dismiss_progress` |
  | `BeckonStateUnit` | the annotation hovered | `client.beckon.hover`; an annotation opened, here or by another participant; `focus` |
  | `SearchPipeline<T>` | a query and the results of the query it settled on | `set_query` |

  A unit acts on a signal a turn of the runtime after it is said, and in the
  order signals were said; a state one of its own methods sets is set when
  the method returns. A request a unit makes has the client's deadline, and
  a unit adds none. An assist that says nothing for `ASSIST_SILENCE` is said
  to have gone quiet (`mark:assist-timeout`) and is still followed.
  `HoverDwell` is the pointer's rest before a hover is said.

  One thing differs from the TypeScript client. Marking composes with
  `MarkSubmitEventSelector`, creates with `AnnotationTargetSelector` and is
  asked with `MarkRequestedEventSelector`: the spec states the one union of
  selectors in three schemas, and Rust has a type for each.
- `state_unit` — what every unit commits to: `dispose`, idempotent, after
  which it is inert and its readers have ended. [tests/census.rs](tests/census.rs)
  fails a unit that has no test holding it to the axioms, and any `static`
  in the crate: state outside an instance is state two units share.
- `retry` — when a failure is worth another attempt, held, as the renewal
  schedule in `session` is, to the shared case tables in `specs/src`
  (`tests/`).
- `bus_log` — `SEMIONT_BUS_LOG`: one grep-able line per frame a process sends
  or receives. Its trace field is read from whatever telemetry the process
  installed (`semiont-observability`).
- `identity` and `roles` — how a knowledge base names its principals, and the
  realm's roles, held to the shared case tables too.
- `testing`, behind the `testing` feature — `FaultyTransport`, a transport
  that fails as a test scripts it and refuses an operation nobody scripted;
  `InMemoryContent`, which keeps what is uploaded and fails a read of what
  nobody stored; `StubGateway`, which answers only what it was told to;
  `SharedStorage`, a storage several contexts share, each hearing what the
  others write; and
  the harnesses for the state-unit axioms (`axioms`, which a consumer's own
  units are held to: `Fresh::of(unit).given(client)` says what the unit was
  given and must not dispose) and the liveness axioms (generated schedules
  of faults), which a transport's own tests run too.

A stream of events says when it fell behind (`Lagged`) instead of dropping
frames silently. No HTTP and no telemetry library: those are its transport's
and the process's, and CI fails if the crate links either. Not yet published.
Its consumers are the Rust services, which is also what proves it: the
dispatcher conformance suite runs against a dispatcher built on it. The SDK
conformance suite ([tests/conformance/sdk](../../tests/conformance/sdk/README.md))
holds its transport to the wire corpus and its client's queries to the live
corpus, at full parity with TypeScript's; [tests/cache.rs](tests/cache.rs)
and [tests/queries.rs](tests/queries.rs) hold the cache clause by clause,
[tests/state.rs](tests/state.rs) each state unit behaviour by behaviour, and
[tests/session.rs](tests/session.rs) and [tests/browser.rs](tests/browser.rs)
a session and the registry.
