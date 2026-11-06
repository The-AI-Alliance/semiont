# Transport Contract

What a Semiont client and the bus promise each other, whatever carries the
bus. Every SDK implements this contract, and every consumer of an SDK may
rely on it. What the HTTP wire adds — the routes, the ids on the stream,
the order of a replay, the limits — is
[TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md).

If the code deviates from what is written here, the code is wrong, or this
document is wrong and is corrected deliberately. There is no third option.

**How this document is held.** Each rule ends with *Held by* and the cases
that fail when a client or a gateway breaks it: a case of the SDK
conformance suite ([`protocol/conformance/sdk`](../conformance/sdk/README.md),
which every SDK runs), a file of the gateway suite
([`protocol/conformance/gateway`](../conformance/gateway/README.md)), or
a test of the reference implementation. A rule marked "Held by no case" is
one nothing checks. `npm run lint:transport-contract` fails when a
case named here does not exist, and when a wire case of the SDK suite is
named by neither transport document.

## The transport

Two primitives carry everything on the bus: an **emit**, one frame out, and
the **stream**, frames in. Beside them, plain request and response carries
bytes (a resource's content) and the gateway's own answers (health, status,
who the caller is, tokens).

A **frame** is an envelope and a payload. The envelope says where the frame
goes: its `channel`; a `scope`, when it belongs to one resource; a
`correlationId`, when it is a request or the reply to one. The payload is
the channel's own type and carries no routing.

A frame carries what `BusFrame` names and nothing more. A reader holds
every frame it is given to `BusFrame` before it delivers it, through the
table a payload is held to (§ Identity), and refuses one with a fault: one
that is no JSON, lacks its `channel` or its `payload`, holds a member of a
kind `BusFrame` does not allow, or carries a member `BusFrame` does not
name. A refused frame is not delivered, and the stream goes on to the
frames after it. Its first fault is named by its way from the frame: a
member of the frame (`correlationId`, `payload`, or one `BusFrame` does not
name), or, for a fault a typed read finds in its payload, `payload.` and
the way within it (§ Identity). One whose `channel` is a text of at least
one character, and that carries no `scope` (a null one is none) or one
that is a resource's id, names its readers, and they are told of it as
they are of a payload that is not its channel's: its frame refusal is
given in its place, on the transport's frames and on every typed read of
its channel in its scope, naming its channel, the way to its fault and why,
with its payload as it came, its scope, and its `correlationId` whenever
that can be read: when the frame carries one `BusFrame` allows. A request
awaiting the reply that correlation id names is told of the refusal at
once (§ Identity). Every SDK's transport gives it
as its own kind of item: Rust as `Err(FrameRefusal)`, Go as a
`*FrameRefusal` error beside the frame's channel and scope, Python as a
`FrameRefusal` in the frame's place, Kotlin as a `FrameRefusal`, which is,
as `Frame` is, `Carried`, Swift as `Carried.refused`, where a frame is
`Carried.frame`, C# as a `FrameRefusal`, which is, as `ReceivedBusFrame`
is, `Carried`, and TypeScript as a `FrameRefusal` in the
payload's place on the frame's scope. Every other refused frame names no
reader, whatever its first fault: one that is no JSON object, that carries
no `channel` or one that is not a text of at least one character, or that
carries a `scope` that is not a resource's id. It is told to the error
stream: as `error`, with no status, saying "the stream carried what is not
a frame: " and then its first fault, in the words a request's refusal says
it in.
*Held by `protocol/specs/src/bus/frame-cases.json`, `packages/python/sdk/tests/test_http_transport.py`, `packages/rust/http-transport/tests/stream.rs`, `packages/go/sdk/stream_test.go`, `packages/kotlin/sdk/src/test/kotlin/semiont/http/StreamTest.kt`, `packages/swift/sdk/Tests/SemiontTests/FrameCasesTests.swift`, `packages/csharp/sdk/tests/Semiont.Tests/FrameCasesTests.cs`, `packages/typescript/http-transport/src/transport/__tests__/actor-state-unit.test.ts`.*

The **registry** ([`protocol/specs/src/bus/registry.json`](../specs/src/bus/registry.json))
is the authority for channels. It classifies each on independent axes:
whether it is half of an operation (a request, its result, its failure);
otherwise its kind (a command or an event); its audience (every client, the
clients holding a resource's scope, or only the clients that declare it);
whether it is an event of the record; and whether emitting it writes.
[EVENT-BUS.md](./EVENT-BUS.md) describes the axes, and
[CHANNELS.md](./CHANNELS.md) lists the channels.

## The surface

The TypeScript rendering, in `@semiont/core`, is the reference. Another
language's SDK offers the same operations in its own idiom.

**`ITransport`: the bus**

| Operation | What it is |
|---|---|
| `emit(channel, payload, envelope?)` | Sends a frame. The envelope carries a scope and a correlation id, when the frame has them. Resolves with the number of clients the gateway reached, or with no count |
| `stream(channel)` | The payloads arriving on a channel |
| `frames(channel)` | The frames arriving on a channel: each payload with its correlation id and scope |
| `on(channel, handler)` | Calls a handler for each payload on a channel, and returns what removes it |
| `isSubscribed(channel)` | Whether the transport receives that channel |

**`ITransport`: the connection**

| Operation | What it is |
|---|---|
| `baseUrl` | Where the transport is connected to |
| `state$` | The connection's state, as it changes |
| `errors$` | The errors the transport raises that belong to no one request |
| `subscribeToResource(resourceId)` | Joins a resource's scope, and returns what leaves it |
| `trackReply(correlationId)` | Says a reply to this correlation id is awaited, and returns what stops the wait |
| `bridgeInto(bus)` | Delivers what the transport receives onto a client's bus |
| `dispose()` | Ends the transport |

`Bus` (`@semiont/core`) is the typed bus over any transport, and a client hands its own out as `client.wire`. Its `request(operation, payload, timeoutMs?, signal?)` is a request and its reply.

**`IContentTransport`**: `putBinary`, `getBinary`, `getBinaryStream`, `getResourceGraph`, `getAnnotations`, `getAnchoredText` and `dispose`.

**`IGatewayOperations`**: `getCurrentUser`, `getMediaToken`, `getProtectedResourceMetadata`, `healthCheck` and `getStatus`.

The lists above are held to the interfaces. This compiles only while each list names exactly its interface's members:

```ts
import type { ITransport, IContentTransport, IGatewayOperations } from '@semiont/core';

type Exactly<T, K extends keyof T> = Exclude<keyof T, K> extends never ? true : never;

export const transport: Exactly<ITransport,
  | 'emit' | 'stream' | 'frames' | 'on' | 'isSubscribed'
  | 'baseUrl' | 'state$' | 'errors$' | 'subscribeToResource' | 'trackReply' | 'bridgeInto' | 'dispose'> = true;
export const content: Exactly<IContentTransport,
  'putBinary' | 'getBinary' | 'getBinaryStream' | 'getResourceGraph' | 'getAnnotations' | 'getAnchoredText' | 'dispose'> = true;
export const gateway: Exactly<IGatewayOperations,
  'getCurrentUser' | 'getMediaToken' | 'getProtectedResourceMetadata' | 'healthCheck' | 'getStatus'> = true;
```

`ITransport` is the bus. `IContentTransport` carries bytes, which never
ride the bus; a resource's description as linked data; a resource's
annotations, which grow without a bound; and a resource's anchored text,
the text read out of its content with where each run of it is on a page,
which is as large as the content it was read from.
`IGatewayOperations` is what a gateway answers for itself; a transport with
no gateway behind it does not implement it.

## Delivery

### A guarantee comes from an identity

A client's stream can be interrupted in two ways. It can **drop**: for a
while there is no connection, and frames published then are not sent to it.
Or it can be **handed over**: what the stream carries changes, a new
connection opens before the old one closes, and for a moment both carry the
same frames.

Every frame has an identity that is the same on every connection. What a
client is promised about a frame across either depends on one thing: what
that identity lets the gateway and the client do.

- By its identity, a client recognises a frame it has already been given. A
  handover cannot double it.
- If that identity is also a **position** in a sequence someone keeps, the
  gateway can be asked for everything after it. A drop cannot lose it.
- An identity that names nothing the gateway keeps gives it nothing to send
  again: the frame reaches whoever is connected when it passes.

### The three classes

| | **Positioned** | **Correlated** | **Passing** |
|---|---|---|---|
| Which frames | an event of the record, delivered on its resource's scope | the reply to a request | every other frame |
| Its identity | its place in that resource's record | the request it answers | its publication: one id, given when it is published |
| Across a handover | delivered once | delivered once | delivered once |
| Across a drop | replayed: the client names, per scope, the last position it holds | sent again: the client names the replies it still awaits | **lost** |
| Bound | what the record still holds | how long the gateway retains a reply | none |
| Past the bound | `bus:resume-gap` names the scope | the request's own timeout | nothing: there is no signal |
| Reaches | every client holding the scope | the one client, and principal, that asked | every client subscribed |
| So a consumer may | apply each once, in order | await it inside its deadline | act only in ways that are safe when missed |

A channel's class follows from the registry's axes and is generated beside
them, as `delivery` in `CHANNEL_ATTRS` (`@semiont/core`): an operation's
result and failure are correlated; an event of the record whose audience is
a resource's scope is positioned; every other channel that crosses the wire
is passing.

- **Positioned.** A client that reopens its stream is sent each scope's
  events after the last one it delivered, once and in order.
  *Held by `sdk/wire/resumption`, `sdk/wire/dedup-window`, `gateway/stream.test.ts`.*
- **Positioned, past the bound.** When the gateway cannot replay what a
  scope missed it says so, on that scope, and delivers what it still can.
  The client then asks again for what it holds of that scope.
  *Held by `gateway/stream.test.ts`, `sdk/live/refresh-bus-resume-gap`.*
- **Correlated.** A reply reaches only the client and principal that made
  the request. One published while the requester's stream was down is sent
  again when the stream reopens, and one carried by both connections of a
  handover is delivered once.
  *Held by `sdk/wire/pending-replies`, `sdk/wire/overlap-dedup`, `gateway/stream.test.ts`, `gateway/replicas.test.ts`.*
- **Passing, across a drop.** A frame published while the stream is down is
  not carried by the stream that reopens.
  *Held by `sdk/wire/passing-across-drop`.*
- **Passing, across a handover.** A frame published while both connections
  are open is carried by both under one id, and the client delivers it once.
  *Held by `sdk/wire/passing-across-handoff`, `gateway/stream.test.ts`, `gateway/replicas.test.ts`.*

Six channels carry events that are in the record and are passing all the
same: `yield:created`, `yield:updated`, `yield:cloned`, `yield:moved`,
`frame:entity-type-added` and `frame:tag-schema-added`. The record is kept
per resource, and these are delivered to every client on no scope, so they
have no position a client could resume from.
*Held by `packages/typescript/core/src/__tests__/bus-classification.test.ts`.*

A **request**, as the service that answers it receives it, is a passing
frame: a service whose stream is down when a request is published is not
sent it later, and the requester's deadline is the bound.
*Held by no case.*

### What repairs a passing frame

Nothing in the transport. A consumer that keeps state from passing frames
repairs a drop by asking:

- **The cache** asks again, when its stream reopens after a drop, for what
  passing events feed and it holds, and asks for nothing after a handover or
  at the first open
  ([CACHE-SEMANTICS B13](CACHE-SEMANTICS.md), from
  the `reopened` row of [`protocol/specs/src/client/refresh.json`](../specs/src/client/refresh.json)).
  *Held by `sdk/live/missed-while-down`, `sdk/live/refresh-reopened`, `sdk/live/reconnect`, `sdk/live/first-open`.*
- **A job's follower** asks for the job's status when the job has been
  silent ([JOBS.md](./JOBS.md#following-a-job)).
  *Held by `sdk/live/job-across-drop`, `sdk/live/job-failed-unheard`.*
- **A follower of the record**, a service that keeps a projection of the
  record (the Weaver's graph, the Smelter's vector index), reads the record
  by position. The record is a set of logs, one for each resource and
  `__system__`, each numbered from 1 with no holes
  ([ARCHIVIST.md](./ARCHIVIST.md#the-event-log)). The follower keeps a
  **cursor** for each log it follows: the last event of it taken.
  - A cursor moves by one, by taking the event right after it: applying it,
    or applying it as nothing where the projection has no use for its type.
  - A delivered event is a hint. At or below the cursor it is dropped; right
    after it, it is taken; further on, the log is read from the record after
    the cursor, and what is read is taken in order. No event is applied out
    of its log's order.
  - A follower receives every event of the record of a log it follows, so a
    gap is always a miss.
  - At its start, and each time its stream opens after a drop, it sweeps:
    each log it follows is taken up to what the record holds.
  - An event the projection refuses as recorded is taken as nothing, and
    counted. One whose taking fails for a passing reason (the store did not
    answer) stops its log where it is: the cursor stays, the log's later
    events wait, and the next sweep takes the log on from there.
  - A log with no cursor at the start is started the projection's own way:
    from its first event, or as the projection rebuilds itself, and then from
    the log's last event as it was before. A log first met after the start
    is a new one, and is taken from its first event.

  *Held by `protocol/specs/src/follower/follow-cases.json`, run by `packages/python/service/tests/test_follow_cases.py`.*

A row of the refresh table whose trigger is a passing channel may only
refetch, and `reopened` refetches whatever it does: the table's generator
refuses anything else.
*Held by `packages/typescript/core/src/__tests__/cache-refresh.test.ts`.*

### Order

- Frames on one channel reach a subscriber in the order they were emitted.
  Across channels there is no order.
  *Held by `gateway/stream.test.ts`.*
- A subscriber receives what is published while it is subscribed, and what
  its class replays. Nothing else.
  *Held by `gateway/stream.test.ts`.*

## The connection

A client holds **one stream**. It names the client's global channels and
one entry per resource scope the client holds.

### State

```
'initial' | 'connecting' | 'open' | 'reconnecting' | 'degraded' | 'unauthenticated' | 'closed'
```

The state answers "can the bus deliver?", and is read as a current value: a
subscriber is given the present state at once.

- **`open` is left only when the stream drops.** A transport that changes
  what its stream carries without missing anything stays `open`, so `open`
  reached again always means something may have been missed. Consumers that
  repair a drop act on exactly that.
  *Held by `sdk/wire/subscribe-matrix`, `sdk/wire/passing-across-handoff`, `sdk/wire/dedup-window`.*
- **A stream that stays down** is `reconnecting`, then `degraded` once it
  has been so for `degradedThresholdMs`, and opens again by itself. A
  dropped stream is a state, never a failure.
  *Held by `sdk/wire/outage`.*
- **`unauthenticated`** means the transport is not attempting: it has no
  credential, or the one it has was refused (§ A refused credential). A
  refused credential is not sent again. The transport waits, with no
  request, and opens its stream when it is given another.
  *Held by `sdk/wire/unauthenticated`, `sdk/wire/stream-credential-limit-renewed`.*
- **`closed`** is terminal: the client was disposed.
  *Held by `sdk/wire/request-closed`.*

The timing a client keeps is [`protocol/specs/src/client/timing.json`](../specs/src/client/timing.json),
from which every SDK generates its constants.

### Failures

Everything a server refused, and every request the gateway never answered,
is reported on the error stream as it is thrown to its caller, under a code
from [`protocol/specs/src/errors/codes.json`](../specs/src/errors/codes.json).
So is every line the stream carried that names no reader (§ The transport).

- **A listener taken as soon as the client is made hears every failure**,
  from the transport's first request on, even when that request was refused
  before the listener was taken.
  *Held by `sdk/wire/stream-rate-limited`, `packages/rust/http-transport/tests/stream.rs`.*
- A refused stream is reported, and opened again no sooner than the
  refusal's `Retry-After`; a stream whose credential was refused waits for
  another credential instead (§ A refused credential).
  *Held by `sdk/wire/stream-rate-limited`, `sdk/wire/unauthenticated`.*
- **A read that got no answer is sent once more**, after
  `requestRetryPauseMs`: one whose connection failed, or closed before any
  response came. A read unanswered at its deadline is not sent again
  ([`protocol/specs/src/client/timing.json`](../specs/src/client/timing.json)).
  *Held by `sdk/wire/read-unanswered`.*
- **An upload that got no answer is sent once more**, after
  `requestRetryPauseMs`, with the key it was first sent with: one whose
  connection failed or closed before its answer reached the client, and one
  answered with a status the `transport` rule retries for a keyed request
  ([`protocol/specs/src/retry/cases.json`](../specs/src/retry/cases.json)).
  The Archivist answers the repeat with the resource the first made, so the
  upload resolves with that resource's id.
  *Held by `sdk/wire/upload-unanswered`, `sdk/wire/upload-answer-lost`, `protocol/specs/src/retry/cases.json`.*
- A gateway that cannot be reached fails an emit or a read as `unavailable`
  once its attempts are spent.
  *Held by `sdk/wire/unreachable`.*

### A refused credential

A request's credential is refused when the gateway answers 401, or 429 with
the `code` `refusal-rate`: a limit that answers only a request whose token
has already failed verification. Whatever the request (an emit, the stream's
connect, a read or an upload, one of the gateway's own operations), a client
that can renew its token does the same:

- **It renews the token once and sends the request again** at once, with
  the token it is given, when that is not the one refused. A request sent
  again and accepted settles as if it had never been refused, and the
  refusal is not reported.
  *Held by `sdk/wire/emit-credential-renewed`, `sdk/wire/emit-credential-limit-renewed`, `sdk/wire/request-credential-renewed`.*
- **It fails as `unauthorized`** when it is given no token, or the one it
  is given is refused too, with the status the gateway answered: a
  `refusal-rate` refusal is never `rate-limited`. The request is not sent a
  third time, and the failure is reported on the error stream.
  *Held by `sdk/wire/emit-credential-refused-twice`, `sdk/wire/request-credential-limit-refused-twice`.*
- **The stream** reports each refused connect as `unauthorized`, renews once
  per outage, and opens with the token it is given; until it has one it is
  `unauthenticated`.
  *Held by `sdk/wire/stream-credential-renewed`, `sdk/wire/stream-credential-limit-renewed`.*
- **What renews the token is told which token was refused**, or that the
  request carried none. One that holds another token by then, because a
  renewal already answered an earlier refusal of the token refused, gives
  the token it holds and renews nothing: a refusal that arrives after the
  renewal costs no second one.
  *Held by `protocol/specs/src/session/cases.json`, its refusal rows, and by `packages/typescript/http-transport/src/transport/__tests__/http-transport.hooks.test.ts`, `packages/python/sdk/tests/test_refused_token.py`, `packages/go/sdk/stream_test.go`, `packages/rust/http-transport/tests/upload.rs`.*

A refused credential is renewed, never retried: no retry rule is asked
about it, and it never waits out a `Retry-After`. A client that cannot renew
its token takes the refusal as final at once.

### Scopes

`subscribeToResource(resourceId)` takes one hold on a resource's scope and
returns what lets it go.

- A scope is on the stream from its first hold to its last release. Holds
  are counted per resource.
  *Held by `sdk/wire/subscribe-matrix`.*
- Distinct resources compose: one stream carries any number of scopes, each
  held and released on its own.
  *Held by `sdk/wire/subscribe-matrix`, `gateway/stream.test.ts`.*
- A scope keeps its position after it is let go: taken again, it resumes
  from there.
  *Held by `sdk/live/refresh-bus-resume-gap`.*

Application code does not call this. A live query of a resource holds the
resource's scope while it is observed: freshness follows observation.
*Held by `sdk/live/scope-by-observation`.*

## Emits

`emit(channel, payload, envelope?)` sends one frame.

- **It resolves when the gateway has accepted it**, with the number of
  subscribers the frame reached, or with nothing when there is no count. An
  absent count stays absent: it is never a zero. No subscriber has
  acknowledged anything.
  *Held by `sdk/wire/emit-counted`, `sdk/wire/emit-uncounted`.*
- **Emits are unordered.** Two emits from one caller may reach a handler in
  either order. A handler that needs an order finds it in the payload.
  *Held by no case.*
- **An emit refused by a limit is sent again**, no sooner than the
  refusal's `Retry-After`, inside the budget `emitRetry`. With the budget
  spent it fails as `rate-limited`. A `refusal-rate` refusal is a refused
  credential, not this.
  *Held by `sdk/wire/emit-rate-limited`, `sdk/wire/emit-budget-spent`.*
- **An emit whose credential is refused** is renewed, as
  § A refused credential says.
  *Held by `sdk/wire/emit-credential-renewed`, `sdk/wire/emit-credential-refused-twice`.*
- **A renewed credential starts a fresh `emitRetry` budget.** The attempts
  made before the renewal are not counted against it, and its backoff
  begins again, so an emit spans at most two budgets: the one before the
  renewal and the one after.
  *Held by `sdk/wire/emit-budget-renewed`.*
- **An emit refused outright fails** with the refusal's code, is reported
  on the error stream, and is not sent again.
  *Held by `sdk/wire/emit-refused`.*
- **`scope`**, when set, makes the emit a broadcast on that resource's
  scope: only subscribers holding the scope receive it.
  *Held by `sdk/wire/emit-counted`, `gateway/stream.test.ts`.*

## Requests

`Bus.request(operation, payload, timeoutMs?, signal?)` is an emit that
expects a correlated reply. The operation is its request channel; its
result and failure channels are the registry's.

- **One emit, one id.** The request carries a correlation id of the client's
  making on its envelope, never in its payload, and resolves with the
  response of the reply that carries the same id.
  *Held by `sdk/wire/request-reply`, `sdk/wire/job-create`.*
- **It is not sent before its reply can arrive.** A request waits, inside
  its own deadline, for the stream to be `open`.
  *Held by `sdk/wire/attach-gate`.*
- **Its id is tracked until it settles.** A client names the replies it
  still awaits whenever it opens a stream, and stops naming one when its
  request has settled.
  *Held by `sdk/wire/pending-replies`, `sdk/wire/request-timeout`.*
- **It settles once**, with the response; or with a failure, under the
  client code the failure's own code becomes; or as a timeout, after
  `busRequestTimeoutMs` unless the caller gave another; or because its
  caller abandoned it.
  *Held by `sdk/wire/failure-codes`, `sdk/wire/request-timeout`.*
- **A result with a fault** is no result, wherever the fault is: the
  request fails as `error`, saying the payload is not its channel's and
  naming its first fault, as § Identity says a fault is named.
  *Held by `protocol/specs/src/resources/reader-cases.json`, `packages/go/sdk/replies_test.go`, `packages/typescript/core/src/__tests__/bus-request.test.ts`.*
- **A request nobody is there to answer** fails as `peer-unavailable` when
  the gateway can tell, and as a timeout when it cannot.
  *Held by `sdk/wire/request-unanswerable`, `gateway/emit.test.ts`.*
- **A request whose replies the stream does not carry** fails at once as
  `unsubscribed`, and nothing is sent.
  *Held by `sdk/wire/request-unsubscribed`.*
- **A request of a closed client** fails as `closed`, and nothing is sent.
  *Held by `sdk/wire/request-closed`.*
- **Abandonment.** A caller that passes a `signal` can abandon the request.
  It then reports nothing more: what was sent stays sent, the reply stops
  being tracked, and a reply that comes anyway settles nothing. Abandoned
  while it waits for the stream, it is never sent.
  *Held by `sdk/wire/request-abandoned`, `sdk/wire/request-abandoned-waiting`.*
- **There is no retry.** A caller that must complete past its deadline asks
  again.
  *Held by no case.*

## Identity

Every command that needs to know who sent it reads the emitter's DID from
`_userId`, a field stamped on the payload on its way to the bus. A client
does not set it, and a handler honours no identity a client supplied.
`_roles`, stamped beside it, is the token's capabilities: authorization for
this emit, never provenance.

- A gateway verifies the caller's token and stamps both, clearing whatever
  the caller wrote there.
  *Held by `gateway/emit.test.ts`.*
- A transport in the same process as the services stamps the identity of
  the process it runs as.
  *Held by no case.*
- An SDK delivers a payload as its channel types it: a stamp the channel's
  payload schema does not declare is the bus's, not the payload's, and is
  left out before the payload is held to its schema. A transport's own
  frames are the wire's, and keep every stamp.
  *Held by `sdk/live/job-failed`, `sdk/live/generation-retried`, `sdk/live/job-created`, `sdk/wire/chunked-stream`.*
- A payload with a fault is not its channel's, wherever the fault is.
  Every SDK holds a payload, before it decodes it, to the table of what
  each component schema requires (written from the schemas by
  `packages/codegen/schemas/required-shapes.mjs`, whose header states the order it is
  walked in), and finds the same first fault: its `member`, the way to it
  (the names of the members it is within and its own, joined by dots; empty
  for the payload itself), and its `reason`, `lacks` (a required member it
  does not carry, or one that holds null where it may not) or `malformed`
  (a member of a kind its schema does not allow, an integer being a number
  with no fractional part; a value its enumeration does not list; a text
  not of its pattern, or with fewer or more code points than it allows; a
  number past its bounds; an array with fewer or more items than it allows;
  or a member a closed object does not name). A member inside a union is
  named as any other. The table states whatever a schema states that some
  SDK's decoding refuses, but a `format` and `uniqueItems`, which none
  refuses. What an SDK's decoding refuses past the table is a fault of the
  payload itself, `malformed` with the empty way: a payload that is no JSON,
  a number past what the SDK's integer holds, and, in Go, Rust, Kotlin and C#,
  whose decoding reads an integer only from a number written without a
  fraction, `1.0` where an integer is required. A typed read tells its reader, in
  place of the frame, and goes on to the frames after it; nothing is
  dropped and nothing is logged instead. It names the fault by its way from
  the frame, `payload.` and the way within the payload (`payload` for the
  payload itself), as it names the fault of a frame its transport refused
  (§ The transport), which it passes on in the same place. Every SDK gives
  either as a `FrameRefusal`. It names the channel, the `member` and the
  `reason`, holds the payload as it came, and carries the frame's
  correlation id whenever that can be read. Rust and Go give it as the
  stream's error, whose words say "a frame on `<channel>` is not that
  channel's: " and then "it has no `<member>`", "its `<member>` is
  malformed", or "it is malformed", the words a request's refusal says a
  fault in. TypeScript, Python, Kotlin and Swift give it as a value the
  reader tells apart from a frame by its `status` (in Swift, its case),
  `refused` where a frame's is `delivered`, and C# as a `Heard<T>` that is
  a `Refused` where a frame's is a `Delivered`. A transport's bridge
  publishes the refusal on the client's own bus in the frame's place; in
  TypeScript, where a reader of payloads tells it apart with `instanceof`,
  in the payload's. A request names a fault of its reply's payload by its
  way within the payload, saying "a payload on `<channel>` is not that
  channel's: " and then the fault. A request is told at once of a reply
  its transport refused, when the refusal carries the request's correlation
  id, and fails with it, as it fails for a reply whose payload is not its
  channel's: under `error`, saying "a frame on `<channel>` is not that
  channel's: " and then the fault. Only a reply whose correlation id cannot
  be read, which carries none, leaves its request to wait out its timeout.
  *Held by `protocol/specs/src/bus/frame-cases.json`, `packages/typescript/core/src/__tests__/bus.test.ts`, `packages/typescript/http-transport/src/transport/__tests__/http-transport.http-paths.test.ts`, `packages/python/sdk/tests/test_bus.py`, `packages/kotlin/sdk/src/test/kotlin/semiont/bus/BusTest.kt`, `packages/swift/sdk/Tests/SemiontTests/ClientTests.swift`, `packages/csharp/sdk/tests/Semiont.Tests/TransportTests.cs`, `packages/rust/sdk/tests/typed.rs`, `packages/go/sdk/internal/required/required_test.go`.*

## Content and the gateway's own operations

Bytes do not ride the bus.

- An upload carries its bytes unchanged, each field under its own name, and
  resolves with the id the gateway answers.
  *Held by `sdk/wire/content-upload`.*
- An upload carries an `Idempotency-Key` header of the client's making: a
  new key for each upload, and the same on every sending of it, the one
  sent again with a renewed credential too
  ([`protocol/specs/src/paths/resources.json`](../specs/src/paths/resources.json)).
  *Held by `sdk/wire/upload-keyed`, `sdk/wire/upload-credential-renewed`.*
- An upload reports its progress as it is sent: how much has gone and how
  much there is, never less than it last said, and all of it by the time it
  resolves.
  *Held by `sdk/wire/upload-progress`.*
- An upload its caller cancels reports nothing more. Its connection is
  closed, nothing is reported on the error stream, and it is not sent again.
  *Held by `sdk/wire/upload-cancelled`.*
- A read returns a resource's bytes unchanged with their media type, whole
  or as a stream; a resource's description is what the gateway answers, and
  so are its annotations; and one that is not there fails as `not-found`.
  *Held by `sdk/wire/content-read`.*
- A resource's anchored text is what the gateway answers: the text with
  where each run of it is on a page, or why there is none. That there is
  none is an answer, never a failure. A read the gateway refuses fails with
  the refusal's code, as a refused read of a description does.
  *Held by `sdk/wire/content-read`.*
- Each of the gateway's own operations is one request to its own path,
  carrying the client's token.
  *Held by `sdk/wire/gateway-operations`.*
- An answer with a fault fails as `error`, with the answer's status,
  saying it is not its declared body and naming its first fault, as
  § Identity says a fault is named; it is reported on the error stream too.
  *Held by `packages/go/sdk/replies_test.go`, `packages/typescript/http-transport/src/transport/__tests__/http-transport.http-paths.test.ts`, `packages/python/sdk/tests/test_withheld.py`, `packages/kotlin/sdk/src/test/kotlin/semiont/http/HttpTransportTest.kt`, `packages/rust/http-transport/tests/answers.rs`.*
- A read or one of the gateway's own operations whose credential is refused
  is renewed, as § A refused credential says.
  *Held by `sdk/wire/request-credential-renewed`, `sdk/wire/request-credential-limit-refused-twice`.*
- So is an upload whose credential is refused, and its progress, sent
  twice, is never less than it last said.
  *Held by `sdk/wire/upload-credential-renewed`, `packages/typescript/http-transport/src/transport/__tests__/http-content-transport.xhr.test.ts`.*

## Telemetry

A client that exports telemetry exports the spans and the count
[`protocol/specs/src/sdk-telemetry/telemetry.json`](../specs/src/sdk-telemetry/telemetry.json)
lists, each of its kind and with its attributes, and nothing else under
their names.
*Held by `sdk/wire/telemetry`.*

## The bus belongs to the client

A client constructs its own local bus and hands the transport a reference
to it with `bridgeInto`. The transport publishes into it every frame it
delivers. The reference flows from client to transport: a transport never
constructs, replaces or is given a bus any other way.
*Held by no case.*

## A transport with no wire

A transport in the same process as the services it reaches has one
connection, which cannot drop and is never handed over. The three classes
collapse: every frame is delivered once.

- Its state is `open` from construction until it is disposed.
- It tracks no replies, because it can lose none.
- It delivers every channel, so `isSubscribed` is true of each.
- Taking a resource's scope changes nothing it delivers.

*Held by no case.*

## What sits above

The cache ([CACHE-SEMANTICS](CACHE-SEMANTICS.md))
takes four things from the transport, and nothing else:

1. **Scope follows observation.** Observing something of a resource holds
   that resource's scope, and positioned events for it then arrive.
2. **An event refreshes what the cache holds** of what the event is about.
3. **A gap refreshes what the cache holds** of the scope the gateway could
   not cover.
4. **A reopened stream refreshes what the cache holds** of what passing
   events feed.

Which event refreshes what is [`protocol/specs/src/client/refresh.json`](../specs/src/client/refresh.json).

## What this document is not

- Not an implementation guide. Each transport's source says how it keeps
  these promises.
- Not the HTTP wire. See [TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md).
- Not a channel inventory. See [CHANNELS.md](./CHANNELS.md).
- Not the bus's own semantics: naming, payload shapes, scoping, what rides
  the bus and what deliberately does not. See [EVENT-BUS.md](./EVENT-BUS.md).
