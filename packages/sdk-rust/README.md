# semiont

[![crates.io](https://img.shields.io/crates/v/semiont.svg)](https://crates.io/crates/semiont)
[![docs.rs](https://img.shields.io/docsrs/semiont)](https://docs.rs/semiont)
[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/crates/l/semiont.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The Rust SDK for [Semiont](../../README.md), an open platform for building
trusted AI knowledge bases: a shared workspace where humans and AI agents
annotate, connect and govern a corpus of documents.

This crate is the client. With it a program reads and writes one knowledge
base: it adds resources, annotates and links them, searches them, gathers
context for a model, and hears what the other participants do as they do it.
A person's application and an AI agent use the same client. The SDK does not
tell them apart.

It has the same namespaces, methods and behaviour as the
[TypeScript SDK](../sdk/README.md) and the
[Python SDK](../sdk-python/README.md), and the three are held to the same
[conformance suite](../../tests/conformance/sdk/README.md). New to Semiont?
The [Introduction](../../docs/builder/INTRODUCTION.md) explains the domain
and the ideas the API falls out of. Its code is TypeScript, and the ideas
are this crate's too.

## Install

```bash
cargo add semiont
cargo add semiont-http-transport --features sign-in
```

Two crates, because the client does no networking of its own:

- **`semiont`** is the client, the protocol's types, and what an application
  holds: sessions, state, storage. It links no HTTP library.
- **[`semiont-http-transport`](../http-transport-rust/README.md)** carries
  it to a knowledge base's gateway and signs people and services in. Its
  README covers TLS and each way to sign in.

A client is built and used inside a [Tokio](https://tokio.rs) runtime, and
speaks to a running knowledge base. The
[Quick Start](../../docs/builder/QUICK-START.md) sets one up on your own
machine.

| Feature | What it adds |
|---|---|
| `charsets` | A resource's text in any charset the Encoding Standard names, as a browser reads it. Without the feature, `browse.resource_content` reads UTF-8 and refuses any other charset by name. `browse.resource_representation` gives the bytes either way. |
| `testing` | Doubles and harnesses for the tests of code built on the client. See [Testing your code](#testing-your-code). |

Every type and method is documented on [docs.rs](https://docs.rs/semiont).

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
[the transport's README](../http-transport-rust/README.md#signing-in).
A person's sign-in gives a `SemiontSession`, and `session.client()` is the
`SemiontClient` the examples below start from. A daemon builds its client
directly, with `client(config, options)`.

## Eight verbs

Every operation belongs to one of eight flows: verbs for what a participant
does with a shared corpus. Four write, three read, and one directs
attention. Each is a namespace of the client.

| | Verb | What it does | Among its methods |
|---|---|---|---|
| Writing | `yield_` | Introduce a resource, uploaded or generated from gathered context | `yield_.resource`, `yield_.delegate` |
| | `mark` | Annotate a resource | `mark.annotation`, `mark.delegate`, `mark.update_entity_types`, `mark.archive` |
| | `bind` | Resolve an ambiguous reference to a specific resource | `bind.body`, `bind.initiate` |
| | `frame` | Define and grow the schema vocabulary | `frame.add_entity_types`, `frame.add_tag_schema` |
| Reading | `browse` | Navigate, read and observe, including who is here | `browse.resource`, `browse.annotations`, `browse.agents`, `browse.click` |
| | `match_` | Search the corpus: resources by text, and candidates for a reference | `match_.resources`, `match_.search` |
| | `gather` | Assemble grounding context around a resource or an annotation, and list what refers to a resource | `gather.resource`, `gather.annotation`, `gather.referenced_by` |
| Attention | `beckon` | Direct attention across participants | `beckon.hover`, `beckon.sparkle`, `beckon.open_resource` |

`yield` and `match` are Rust's own words, so those two namespaces take a
trailing underscore. Beside the eight are `job`, and `auth` and `system`
when the client has a gateway. What each flow means is in
[docs/protocol/flows](../../docs/protocol/flows/README.md).

## A first program

From a signed-in client, this ingests a paper, has a model mark the concepts
it mentions, gathers the context around it, and generates a summary grounded
in that context. Those are the
[Quick Start](../../docs/builder/QUICK-START.md)'s last two steps, from code,
and the two that come next. [Connect](#connect) is how a client comes to be
signed in.

```rust
// Ingest: the paper's bytes become a resource.
let created = client
    .yield_
    .resource(PutBinaryRequest::new(
        "Attention Is All You Need",
        paper,
        "application/pdf",
        "file://papers/attention-is-all-you-need.pdf",
    ))
    .await?;
let paper_id = created.resource_id;

// Annotate: a model reads it and marks each mention of a concept.
client
    .mark
    .delegate(&paper_id, LinkingJobParams::new(vec!["Concept".to_owned()]))
    .await?;

// Gather: the paper, its annotations, and what the knowledge base holds
// around it.
let context = client
    .gather
    .resource(&paper_id, GatherResourceRequestOptions::default())
    .await?;

// Generate: a new resource, grounded in that context and linked to its
// source.
let done = client
    .yield_
    .delegate(
        GenerationJobParams {
            task: Some("summary".to_owned()),
            ..GenerationJobParams::new(
                "Attention Is All You Need: a summary",
                "file://generated/attention-summary.md",
                context,
            )
        },
        None,
    )
    .await?;
// The completion is a yield job's: the resource it made, or a decline.
let summary = match done.result {
    Some(YieldJobResult::GenerationResult(generated)) => Some(generated.resource_id),
    Some(YieldJobResult::DeclinedResult(_)) | None => None,
};
```

A request that must state some things and may leave others out is made with
`new`, from what it must state: `PutBinaryRequest::new` here, and
`GenerationJobParams::new` with its `task` said beside it. Every such type of
the protocol has one.

Both resources, and every annotation the model made, are in the knowledge
base for the next participant, person or agent, to read and build on.

Where to go from here:

- The [Developer Guide](../../docs/builder/DEVELOPER-GUIDE.md) has each of
  these steps as a recipe, and the ones after them: reading, searching,
  annotating by hand, reacting to what others do, and testing. Its code is
  TypeScript, and [the table below](#from-the-typescript-sdk) maps each shape
  to this crate's.
- The [agent skills](../../docs/builder/skills/README.md) are whole scripts,
  one per task, for an AI coding assistant to load: ingesting a corpus,
  annotating it, linking it, and the layers built on those. They are
  TypeScript as well.

## Three ways to use it

One client, `SemiontClient`, serves all three. What differs is what its
caller waits on.

**A script** asks, awaits and uses `?`. A query is read once with `.fresh()`,
and a job another party does is awaited for its completion.

```rust
// Asked once, answered once.
let about = client.browse.kb().await?;
println!("{} at {}", about.name, about.domain);

// A query, read once.
let resource = client.browse.resource(&resource_id).fresh().await?;
println!("{}", resource.name);

// A job another party does, awaited for its completion.
let done = client
    .mark
    .delegate(&resource_id, HighlightingJobParams::new())
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
a person has registered and the active one's session. A state unit holds one
flow over that session's client. Each is read through a
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

## A worker

A worker claims jobs from a knowledge base's queue, does each one, and says
what became of it. `client.job.claim` is its side of the queue. It is given
what the worker accepts, each a `JobFilter`: the `mark` jobs of one
motivation, or the `yield` jobs. The `Claims` it returns hand out the jobs
the worker comes to hold, one at a time, and a held job says its own
lifecycle.

A worker signs in as an agent, which is the transport crate's to do, so a
whole worker is shown, compiled and run, in
[the transport's README](../http-transport-rust/README.md#a-daemon).

- **Its stream names `JOB_CLAIM_CHANNELS`**, and the reply channels of
  whatever else it awaits. The announcements that wake an idle worker reach
  only a stream that names them, so a client whose stream does not is handed
  one refusal, `Unsubscribed`, and claims nothing.
- **It claims when it is idle**: when its claims are first read, each time a
  job settles, when a job it accepts is announced, and when its stream opens
  again. A claim answered with nothing pending is no refusal, and the worker
  waits. `claims.next().await` gives the next held job, or the next claim
  the dispatcher refused or did not answer.
- **A held job is its verb's**: `HeldJob::Mark` or `HeldJob::Yield`, matched
  before `complete`, since a completion carries what its verb reports.
  `start` comes first, and `progress` and `checkpoint` as often as there is
  something to say.
- **A held job settles once.** `complete`, `fail` and `cancel` each take the
  job by value, say the outcome and let it go, so settling twice does not
  compile.
- **A job is never left.** One dropped unsettled is failed, and
  `claims.stop().await` fails the job the worker still holds. The queue then
  runs it again at once, where a job whose worker was killed waits for the
  dispatcher's sweep.
- **`fail` says whether the queue will run the job again**
  (`will_retry_after`), from the budget on the record the worker claimed and
  the failure's class: `FailureClass::Deterministic` is a failure no second
  attempt can change.
- **A cancellation is signalled.** `job.cancelled()` turns true when a
  cancellation names the held job: the work stops where it can, and says
  `job.cancel(..)`.
- **`claims.vitals()`** is what the worker can say of itself: when it last
  heard an announcement, claimed, was active and settled, the job it holds,
  and how many it has completed. **`claims.stalled()`** tells of a held job
  that has shown no activity for fifteen minutes.

What a worker promises the dispatcher is the
[worker contract](../../docs/protocol/WORKER-CONTRACT.md), and
[its conformance suite](../../tests/conformance/worker/README.md) holds this
crate to it.

## What a method returns

A method's return type says how to use it.

| A method that returns | is | used as |
|---|---|---|
| `async fn … -> Result<T, SemiontError>` | asked once, answered once | `.await?` |
| `Running<T>` | a long-running operation | `.await` for its final value; `.next()` for each report and then the final value; `.run(f)` for both |
| `Delegation<C>` | a job another party does | `.await` for its completion, a `C`: its verb's, `MarkJobCompleteCommand` or `YieldJobCompleteCommand`; `.next()` for each of the job's events, the completion last |
| `Upload` | an upload in flight | `.await` for the resource created; as a stream, its progress; dropped, cancelled |
| `Cached<T>` | a query, built without touching the wire | `.watch()` for its state now and as it changes; `.fresh().await?` for one read; `.invalidate()` to ask again |
| nothing, from a plain `fn` | a signal to the client's own parts | called |
| `async fn … -> Result<Option<u64>, SemiontError>` | a drive at the other participants | `.await?`: how many the gateway reached, `None` when it kept no count |
| `Typed<C, BusFrames>` | one channel's events, from now on | `.next()` |
| `Claims` | a worker's claims, from `job.claim` | `.next().await` for the next job the worker holds, or the next claim it was refused; a held job says its own lifecycle, and `complete`, `fail` and `cancel` take it by value |

A `Running` and an `Upload` are consumed by value, so one operation is never
started twice. Nothing is sent until one is first polled, and dropping one
abandons it.

A watched query (`Observed<T>`) gives `CacheState<T>`: `Pending`,
`Ready(value)` or `Failed(error)`. `Failed` is a state, not the end of the
stream: the next watcher, or `invalidate`, tries again. While a query of one
resource is watched, the client holds that resource's scope, which is what
brings it that resource's events, and lets go of it when the watcher is
dropped. A watcher that falls behind is given the latest state, not each one
it missed. The rules a query keeps are
[Cache Semantics](../../docs/protocol/CACHE-SEMANTICS.md).

A stream of events never drops frames silently. A reader that falls behind
is given `Lagged(n)` in place of what it missed, and reads on.

A failure is a `SemiontError`, and `.code()` is the code every Semiont SDK
shares for it.

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

## Sessions

- **`SemiontSession`** is one session with one knowledge base: a client, the
  token its transport sends, and who is signed in. It renews its token
  before the token expires, and again when the gateway refuses it. A session
  that cannot be renewed clears its token and what it stored, and says so
  once.
- **`SemiontBrowser`** is what an application holds: the knowledge bases a
  person has registered, which one is active, the active one's session, and
  what the person has open in each. One session is live at a time.
- **`SessionSignals`** is what a host shows about a session: that it ended
  and why, that a request was refused for lack of permission, or that a
  different knowledge base is answering. A signal says what happened. The
  sentence a person reads is the host's.
- **`SessionFactory`** builds a knowledge base's session. A browser is given
  one, and so knows nothing of how a knowledge base is reached.
  `semiont-http-transport` has the one over a gateway.

What must outlive a client is kept in a `SessionStorage`
(`semiont::storage`). `semiont::sign_in_store` is the sign-ins
`semiont login` keeps ([sign-in store](../../specs/src/sign-in-store/README.md)),
as a `SessionStorage`, so one sign-in serves the launcher and an application
built on this SDK.

## State units

A state unit holds one flow as state, for an application to read and watch.
It is built over an `Arc<SemiontClient>` it never closes, and is read through
`tokio::sync::watch` receivers. A new session has a new client, so a unit
lasts as long as the session it was built from. `dispose` ends a unit, and
so does dropping it.

| Unit | holds | hears, or is told |
|---|---|---|
| `MarkStateUnit` (one resource) | the annotation being composed; the motivation and progress of the delegated job running | `client.mark.request`, `submit`, `cancel_pending`, `request_delegate`, `dismiss_progress`; `mark:select-*` on the client's bus |
| `GatherStateUnit` (one resource) | an annotation's context, and a resource's, each with its loading and its failure | `gather:requested` on the client's bus; `gather_resource` |
| `MatchStateUnit` | nothing: it answers on the bus, under the asker's correlation id | `client.match_.request_search` |
| `YieldStateUnit` | whether a generation runs, its progress, what it produced, and why it ended without a result | `generate`, `dismiss_progress` |
| `BeckonStateUnit` | the annotation hovered | `client.beckon.hover`; an annotation opened, here or by another participant; `focus` |
| `SearchPipeline<T>` | a query and the results of the query it settled on | `set_query` |

The ideas behind them are in [State Units](../../docs/builder/STATE-UNITS.md).

## Ending things: `close` and `Drop`

Everything the crate gives ends when it is dropped. `close` is for what
dropping cannot do: wait.

| | `close().await` | dropped |
|---|---|---|
| `SemiontClient` | Its queries end, its transport closes so that every request still pending fails as closed, and its own bus ends. | Its queries and its own bus end. The transport is left to whoever else holds it. |
| `SemiontSession` | The same, and its client is closed. | It stops renewing and what it holds ends. Its client is left open. |
| `SemiontBrowser` | The active session is closed, and everything it holds ends. | Everything it holds ends. The active session is dropped, not closed. |
| a state unit | `dispose()`, which is not async: it is inert and its readers have ended. | The same. |
| `Running<T>`, `Delegation<C>`, `Upload` | | The operation is abandoned; an upload is cancelled. |
| a watcher of a query | | The resource's scope it held is let go. |

A process that is ending calls `close` on what it built, so that what is in
flight ends by being told and not by the runtime stopping.

## Testing your code

The `testing` feature is what a consumer's tests are built on. A double
answers what a test told it to and refuses the rest by name. None answers
with a value of its own making.

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

- `create_test_client` gives a real `SemiontClient` over a `FaultyTransport`
  and an `InMemoryContent`. `create_test_session` gives a real
  `SemiontSession` over one, ready at once.
- `FaultyTransport` fails as a test scripts it: what the wire does to each
  request, and what the gateway answers. A reply that names what it
  answers for, as a gathered context names its resource, takes that from the
  request, so a test queues the response alone. `InMemoryContent` keeps what is
  uploaded and fails a read of what nobody stored. `StubGateway` answers
  only what it was told to.
- `ScriptedSessions` is a `SessionFactory` for a `SemiontBrowser`: each
  session is real, over a transport of its own, and a test scripts what each
  knowledge base answers, who a token is and what a renewal gives.
  `SharedStorage` is a storage several contexts share, each hearing what the
  others write.
- `axioms` holds a state unit, a consumer's own too, to the rules every unit
  keeps. `liveness` holds a composition over the bus to the liveness rules,
  under generated schedules of faults. A transport's own tests run it too.
- `examples` holds a README's Rust blocks to source that compiles and runs.
  Every block on this page is held that way.

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

## What is in the crate

Each module is documented on [docs.rs](https://docs.rs/semiont).

| Module | What it holds |
|---|---|
| `client` | `SemiontClient` and its options |
| `namespaces` | The methods of each namespace, and the options they take |
| `running`, `cached` | `Running<T>`, `Upload` and `Cached<T>`: what long-running operations and queries return |
| `types` | The protocol's types, generated from the spec when the crate is built: the ids, and every request, response and event |
| `channels` | The bus's channels, one type each, naming its payload. A channel the protocol does not have, or a payload that is not that channel's, does not compile. Each is `Scoped`, carried by a resource's scope, or `Unscoped`. |
| `errors`, `timing`, `retry` | The failure codes, the deadlines and the retry rules every Semiont SDK shares |
| `annotations` | The readers of an annotation: the resource it is on and the one it links to, the text it quotes, its entity types, its tag, and what kind it is. Its target is an id or an object, its selector one or a list, its body absent, one item or a list, and these read each. [`reader-cases.json`](../../specs/src/annotations/reader-cases.json) holds every SDK's readers to the same answers. |
| `claims`, `job_filter` | A worker's side of the job queue: its claims, the jobs it holds, whether a failed job is retried, and whether a job is one a claim takes. What a worker promises is the [worker contract](../../docs/protocol/WORKER-CONTRACT.md) |
| `session` | `SemiontSession`, `SemiontBrowser`, `SessionFactory`, `SessionSignals` |
| `storage`, `sign_in_store` | Where a client keeps what must outlive it, and the sign-ins `semiont login` keeps |
| `state`, `state_unit` | The state units, and what every unit commits to |
| `cache`, `refresh`, `resume` | The cache queries answer from, what each event does to it, and where a stream resumes after a restart |
| `transport` | The contract a transport implements: `Transport`, `ContentTransport`, `GatewayOperations` |
| `bus`, `event_bus` | The typed client of the bus over a transport, and a client's own in-process bus. `bus.stream::<C>()` reads a channel of no scope. A resource's channel is read for the resource, `bus.stream_of::<MarkAdded>(&resource)`, which holds that resource's scope until it is dropped; read with no resource, it does not compile. |
| `media_types` | The media types a knowledge base admits, and what the system can do with each |
| `discovery` | The knowledge bases a launcher manages |
| `identity`, `roles` | How a knowledge base names its people and agents, and the realm's roles |
| `bus_log` | With `SEMIONT_BUS_LOG` set, one line on stderr per frame the process sends or receives, and per content read |
| `testing` | The doubles and harnesses, behind the `testing` feature |

`SEMIONT_BUS_LOG` is the only environment variable the crate reads.
Everything else it needs, it is given: an application reads its own
environment and says what it found.

## The other crates

| Crate | |
|---|---|
| [`semiont-http-transport`](../http-transport-rust/README.md) | The transport over a gateway, and signing in. A program that reaches a knowledge base uses it. |
| [`semiont-telemetry`](../telemetry-rust/README.md) | The spans and counts the transport reports, to whatever OpenTelemetry an application installs. Its README says how to turn tracing on. |
| [`semiont-codegen`](../codegen-rust/README.md) | The build-time generator of `semiont::types`. Cargo builds it for you. |

## License

Apache-2.0. See [LICENSE](../../LICENSE).
