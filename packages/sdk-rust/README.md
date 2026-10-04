# semiont (Rust)

[![crates.io](https://img.shields.io/crates/v/semiont.svg)](https://crates.io/crates/semiont)
[![docs.rs](https://img.shields.io/docsrs/semiont)](https://docs.rs/semiont)
[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/crates/l/semiont.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The Rust SDK for [Semiont](../../README.md), an open platform for building
trusted AI knowledge bases: a shared workspace where humans and AI agents
annotate, connect and govern a corpus of documents. This crate is a client
of one knowledge base, as [`specs/`](../../specs/src/openapi.json) states
it, over any transport. A person's application and an agent reach it the
same way: the SDK does not tell them apart.

It is a full peer of the [TypeScript SDK](../sdk/README.md): the same
namespaces, methods and behaviour, held to the same
[conformance suite](../../tests/conformance/sdk/README.md). New to Semiont?
The [Introduction](../../docs/builder/INTRODUCTION.md) explains the domain and the
ideas the API falls out of. Its code is TypeScript, and the ideas are this
crate's too.

## Install

```bash
cargo add semiont
cargo add semiont-http-transport --features sign-in
```

`semiont` is the client. It links no HTTP, and it is built inside a Tokio
runtime. [`semiont-http-transport`](../http-transport-rust/README.md) is the
transport over a gateway, with the sessions and signing in. Its `sign-in`
feature signs a person in, and a service leaves it off. The reference for
every item is on [docs.rs](https://docs.rs/semiont).

## Connect

A client comes from signing in. A person signs in at the identity provider
the knowledge base trusts, never at the gateway, and their password never
passes through the process. How depends on what is signing in, and each way
is the transport crate's:

| Who | Signs in with | |
|---|---|---|
| A script, after `semiont login` | `session_from_stored` | The launcher's sign-in, reused. |
| A script on its own | `sign_in_device` | The person approves a code in any browser. |
| An application | `begin_sign_in`, `complete_sign_in` | The person is sent to the issuer and back to this machine. |
| A daemon | `AgentToken::sign_in` | A service account. It needs no `sign-in` feature. |

Each is shown, compiled and run, in
[the transport's README](../http-transport-rust/README.md#three-ways-to-use-it).
A person's sign-in gives a `SemiontSession`, and `session.client()` is the
`SemiontClient` the examples below start from. A daemon builds its client
directly, with `client(config, options)`.

## Eight verbs

Every operation belongs to one of eight flows: verbs for what a participant
does with a shared corpus. Each is a namespace of the client.

| Verb | What it does | Among its methods |
|---|---|---|
| `browse` | Navigate, read and observe, including who is here | `browse.resource`, `browse.annotations`, `browse.agents`, `browse.click` |
| `bind` | Resolve an ambiguous reference to a specific resource | `bind.body`, `bind.initiate` |
| `yield_` | Introduce a resource, uploaded or generated from gathered context | `yield_.resource`, `yield_.from_context` |
| `mark` | Annotate a resource | `mark.annotation`, `mark.assist`, `mark.update_entity_types`, `mark.archive` |
| `frame` | Define and grow the schema vocabulary | `frame.add_entity_types`, `frame.add_tag_schema` |
| `gather` | Assemble grounding context around a resource or an annotation | `gather.resource`, `gather.annotation` |
| `match_` | Search the corpus for candidate resources | `match_.search` |
| `beckon` | Direct attention across participants | `beckon.hover`, `beckon.sparkle`, `beckon.open_resource` |

`yield` and `match` are Rust's own words, so those two namespaces take a
trailing underscore. Beside the eight are `job`, and `auth` and `system`
when the client has a gateway. What each flow means is in
[docs/protocol/flows](../../docs/protocol/flows/README.md).

## Three ways to use it

One client, `SemiontClient`, serves all three. What differs is what its
caller waits on.

**A script** asks, awaits and uses `?`. A query is read once with `.fresh()`,
and a long-running operation is awaited for its final value.

```rust
// Asked once, answered once.
let about = client.browse.kb().await?;
println!("{} at {}", about.name, about.domain);

// A query, read once.
let resource = client.browse.resource(&resource_id).fresh().await?;
println!("{}", resource.name);

// A long-running operation, awaited for its final value.
let done = client
    .mark
    .assist(
        &resource_id,
        Motivation::Highlighting,
        MarkAssistOptions::default(),
    )
    .await?;
```

**A daemon** reads streams. Each gives what happens from the moment it is
taken, and ends when the client closes.

```rust
// Every job that completes, from now on, until the client closes.
let mut completed = client.job.complete();
while let Some(event) = completed.next().await {
    match event {
        Ok(job) => done(job.payload),
        // A reader that fell behind is told how far, and reads on.
        Err(behind) => eprintln!("{behind}"),
    }
}
```

**An application** holds state. A `SemiontBrowser` keeps the knowledge bases
a person has registered and the active one's session; a state unit holds one
flow over that session's client; and each is read through a
`tokio::sync::watch` receiver: the value now, and each value after it.

```rust
// What an application holds: its knowledge bases, which one is active,
// and the active one's session.
let browser = SemiontBrowser::new(SemiontBrowserConfig {
    storage,
    session_factory,
});
let mut live = browser.active_session();
let session = live.wait_for(Option::is_some).await?.clone();

// A flow, held as state over the session's client: here, the annotation
// being composed on a resource.
if let Some(session) = session {
    let marking = MarkStateUnit::new(session.client().clone(), &resource_id);
    let mut pending = marking.pending();
    while pending.changed().await.is_ok() {
        render(pending.borrow_and_update().as_ref());
    }
}
```

## Ids

A resource, an annotation, a job and whoever did something are each named by
an id of its own type: `ResourceId`, `AnnotationId`, `JobId`, `UserId`
(`semiont::types`). The rule each is held to is the spec's
([`specs/src/identifiers/kinds.json`](../../specs/src/identifiers/kinds.json)):
the first three are a name of 1 to 128 letters, digits, `_` and `-`, never a
URI or a path, and the last is a DID.

```rust
// An id is made from text by its kind's rule.
let resource_id: ResourceId = "5bcd259ab1464cf68a556bbad21f513f".parse()?;
// Text the rule refuses is refused here, before anything is sent.
assert!(ResourceId::new("../another").is_err());
// It reads as the text it is.
println!("{resource_id}, {} characters", resource_id.len());
```

Nothing makes one but its constructor, and decoding goes through it: an id
in an answer has passed the same rule as one a caller made, and an answer
carrying one that does not fails to decode. One kind is never taken for
another: `mark.delete(&annotation_id, &resource_id)` does not compile.

## From the TypeScript SDK

The two SDKs have the same namespaces, methods and behaviour: both are held
to [`specs/src/client/surface.json`](../../specs/src/client/surface.json)
and the same case tables. What differs is how each language says "later".

| TypeScript | Rust | |
|---|---|---|
| `Promise<T>` | `async fn … -> Result<T, SemiontError>` | `.await?` |
| an `Observable` of events | a `Stream` | A reader that falls behind is given `Lagged(n)` in place of what it missed. Nothing is dropped silently. |
| a `BehaviorSubject` of state | a `watch::Receiver` | The value now, and each value after it. A slow reader sees the latest value and not each one between: state is what is true now. What must be seen in sequence, such as a job's progress, is a stream. |
| `StreamObservable<T>` | `Running<T>` | `.await` for the final value, `.next()` for each report. It is consumed by value, so one operation is never started twice. |
| `UploadObservable` | `Upload` | `.await` for the resource created; as a stream, its progress; dropped, cancelled. |
| `CacheObservable<T>` | `Cached<T>` | `.watch()` for its state, `.fresh().await?` for one read. Neither is awaited itself. |
| a method returning `void` | a plain `fn` | A signal. One that fails is said on the transport's failure stream. |
| `client.yield`, `client.match` | `client.yield_`, `client.match_` | `yield` and `match` are Rust's own words. |
| RxJS operators | `futures::StreamExt`, `tokio-stream` | The crate brings no operator library. |
| `@semiont/sdk/testing` | `semiont::testing`, behind the `testing` feature | |

## Ending things: `close` and `Drop`

Everything the crate gives ends when it is dropped. `close` is for what
dropping cannot do: wait.

| | `close().await` | dropped |
|---|---|---|
| `SemiontClient` | Its queries end, its transport closes so that every request still pending fails as closed, and its own bus ends. | Its queries and its own bus end. The transport is left to whoever else holds it. |
| `SemiontSession` | The same, and its client is closed. | It stops renewing and what it holds ends. Its client is left open. |
| `SemiontBrowser` | The active session is closed, and everything it holds ends. | Everything it holds ends. The active session is dropped, not closed. |
| a state unit | `dispose()`, which is not async: it is inert and its readers have ended. | The same. |
| `Running<T>`, `Upload` | | The operation is abandoned; an upload is cancelled. |
| a watcher of a query | | The resource's scope it held is let go. |

A process that is ending calls `close` on what it built, so that what is in
flight ends by being told and not by the runtime stopping.

## What is in the crate

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

  One thing differs from the TypeScript client. `browse.resource_content`
  decodes the charset the content's media type states, and with the
  `charsets` feature that is every encoding the Encoding Standard names, as
  a browser reads them. Without the feature it decodes UTF-8 and refuses any
  other charset by name. `browse.resource_representation` gives the bytes
  either way.
- `running` and `cached` — those two shapes.
- `cache` — what the queries answer from
  ([CACHE-SEMANTICS](../../docs/protocol/CACHE-SEMANTICS.md)): one state per key, the
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
    says so once. One that never had a credential is only signed out. A
    token the gateway refuses is renewed once, and the gateway is asked who
    the renewed one is; a token the issuer has just issued and the gateway
    refuses ends the session (`SessionErrorCode::CredentialRefused`). So a
    session that starts on a stored token asks at most twice and renews at
    most once, a refusal of a running session costs at most one renewal and
    one ask, and a session that is over asks nothing more
    ([specs/src/session/cases.json](../../specs/src/session/cases.json),
    `startup` and `refusal`).
  - `SemiontBrowser` is what an application holds: the knowledge bases it
    has registered, which is active, the active one's session, and what a
    person has open in each. One session is live at a time. A sign-in lands
    on the entry, among those at its address, whose did is the one the
    knowledge base reported, or on a new entry: an entry's did never
    changes. When a session comes up the knowledge base is asked who it is
    and each open resource is checked against it; only a resource the
    knowledge base says is gone is closed, and a different knowledge base
    answering voids what was open and is raised for a host to show.
  - `SessionSignals` is what a host shows about a session: that it ended,
    and why (`SessionEndReason`: expired, or its credential refused); that a
    request was refused for lack of permission, with the refusal's message;
    that a different knowledge base is answering. A notice
    says what happened, never a sentence: what a person reads is the host's.
  - `SessionFactory` builds a knowledge base's session and ends its
    credentials. A browser is given one, and so knows nothing of how a
    knowledge base is reached. `semiont-http-transport` has the one over a
    gateway, and signing in at an issuer.

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
- `media_types` — the media types a knowledge base admits and what the
  system can do with each, generated from
  [specs/src/media-types/registry.json](../../specs/src/media-types/registry.json):
  `MEDIA_TYPES`, `capabilities_of`, and the two rules a clone needs, the
  format it takes (`clone_format`) and the name its content is stored under
  (`storage_file_name`, `derive_storage_uri`). The rules are held by
  [cases every SDK runs](../../specs/src/media-types/cases.json).
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
  | `MarkStateUnit` (one resource) | the annotation being composed; the motivation and progress of the assist running | `client.mark.request`, `submit`, `cancel_pending`, `request_assist`, `dismiss_progress`; `mark:select-*` on the client's bus |
  | `GatherStateUnit` (one resource) | an annotation's context, and a resource's, each with its loading and its failure | `gather:requested` on the client's bus; `gather_resource` |
  | `MatchStateUnit` | nothing: it answers on the bus, under the asker's correlation id | `client.match_.request_search` |
  | `YieldStateUnit` | whether a generation runs, its progress, what it produced, and why it ended without a result | `generate`, `dismiss_progress` |
  | `BeckonStateUnit` | the annotation hovered | `client.beckon.hover`; an annotation opened, here or by another participant; `focus` |
  | `SearchPipeline<T>` | a query and the results of the query it settled on | `set_query` |

  A unit acts on a signal a turn of the runtime after it is said, and in the
  order signals were said; a state one of its own methods sets is set when
  the method returns. A request a unit makes has the client's deadline, and
  a unit adds none. An assist that says nothing for `ASSIST_SILENCE` is said
  to have gone quiet (`mark:assist-timeout`) and is still followed.
  `HoverDwell` is the pointer's rest before a hover is said.

- `state_unit` — what every unit commits to: `dispose`, idempotent, after
  which it is inert and its readers have ended. [tests/census.rs](tests/census.rs)
  fails a unit that has no test holding it to the axioms, and any `static`
  in the crate: state outside an instance is state two units share.
- `retry` — when a failure is worth another attempt, held, as the renewal
  schedule in `session` is, to the shared case tables in `specs/src`
  (`tests/`).
- `bus_log` — `SEMIONT_BUS_LOG`: one grep-able line per frame a process sends
  or receives. Its trace field is the active span's trace, read by the
  function the process gave it (`set_trace_id_provider`):
  [`semiont-telemetry`](../telemetry-rust/README.md)'s `active_trace_id`.
- `identity` and `roles` — how a knowledge base names its principals, and the
  realm's roles, held to the shared case tables too.
- `testing`, behind the `testing` feature — what a consumer's tests are
  built on. A double answers what a test told it to and refuses the rest by
  name; none answers with a value of its own making.
  - `create_test_client` gives a real `SemiontClient` over a
    `FaultyTransport` and an `InMemoryContent`, and `create_test_session` a
    real `SemiontSession` over one, ready at once.
  - `ScriptedSessions` is a `SessionFactory` for a `SemiontBrowser`: each
    session is real, over a transport of its own, and a test scripts what
    each knowledge base answers, who a token is and what a renewal gives.
  - `FaultyTransport` fails as a test scripts it: a schedule of what the
    wire does to each request, and the responses the gateway gives.
    `InMemoryContent` keeps what is uploaded and fails a read of what nobody
    stored. `StubGateway` answers only what it was told to. `SharedStorage`
    is a storage several contexts share, each hearing what the others write.
  - `axioms` holds a state unit to the axioms, a consumer's own too:
    `Fresh::of(unit).given(client)` says what the unit was given and must
    not dispose. `liveness` holds a composition over the bus to the liveness
    axioms under generated schedules of faults; a transport's own tests run
    it too.
  - `examples` holds a README's code to source that compiles and runs. This
    one's is [tests/readme.rs](tests/readme.rs).

  ```rust
  // A real client over doubles: script the transport, observe the client.
  let test = create_test_client(TestClientOptions::default());
  test.transport.queue_reply(
      "browse:kb-requested",
      [Some(
          json!({ "name": "A knowledge base", "domain": "example.org" }),
      )],
  );
  assert_eq!(test.client.browse.kb().await?.name, "A knowledge base");

  // What nobody scripted is refused, naming the operation.
  let refused = test.client.browse.entity_types().fresh().await;
  assert!(refused.is_err());
  ```

A stream of events says when it fell behind (`Lagged`) instead of dropping
frames silently. No HTTP and no telemetry library: those are its transport's
and the process's, and CI fails if the crate links either.
Its consumers are the Rust services, which is also what proves it: the
dispatcher conformance suite runs against a dispatcher built on it. The SDK
conformance suite ([tests/conformance/sdk](../../tests/conformance/sdk/README.md))
holds its transport to the wire corpus and its client's queries to the live
corpus, at full parity with TypeScript's; [tests/cache.rs](tests/cache.rs)
and [tests/queries.rs](tests/queries.rs) hold the cache clause by clause,
[tests/state.rs](tests/state.rs) each state unit behaviour by behaviour, and
[tests/session.rs](tests/session.rs) and [tests/browser.rs](tests/browser.rs)
a session and the registry.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
