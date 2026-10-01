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
conformance suite ([`tests/conformance/sdk`](../../tests/conformance/sdk/README.md),
which every SDK runs), a file of the gateway suite
([`tests/conformance/gateway`](../../tests/conformance/gateway/README.md)), or
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

The **registry** ([`specs/src/bus/registry.json`](../../specs/src/bus/registry.json))
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

```ts
interface ITransport {
  readonly baseUrl: BaseUrl;

  // The bus
  emit(channel, payload, envelope?: { scope?, correlationId? }): Promise<number | undefined>;
  stream(channel): Observable<payload>;
  frames(channel): Observable<{ payload, correlationId?, scope? }>;
  on(channel, handler): () => void;
  isSubscribed(channel): boolean;

  // The connection
  readonly state$: Observable<ConnectionState>;
  readonly errors$: Observable<SemiontError>;
  subscribeToResource(resourceId): () => void;
  trackReply(correlationId): () => void;
  bridgeInto(bus: EventBus): void;
  dispose(): void;
}

// A request and its reply, over any transport
busRequest(transport, operation, payload, timeoutMs?, signal?): Promise<response>;

interface IContentTransport {
  putBinary(request, options?): Promise<{ resourceId }>;
  getBinary(resourceId): Promise<{ data, contentType }>;
  getBinaryStream(resourceId): Promise<{ stream, contentType }>;
  getResourceGraph(resourceId): Promise<GetResourceResponse>;
  dispose(): void;
}

interface IGatewayOperations {
  getCurrentUser(); getMediaToken(resourceId); getProtectedResourceMetadata();
  healthCheck(); getStatus();
}
```

`ITransport` is the bus. `IContentTransport` carries bytes, which never
ride the bus, and a resource's description as linked data.
`IGatewayOperations` is what a gateway answers for itself; a transport with
no gateway behind it does not implement it.

## Delivery

### A guarantee comes from an identity

A client's stream can be interrupted in two ways. It can **drop**: for a
while there is no connection, and frames published then are not sent to it.
Or it can be **handed over**: what the stream carries changes, a new
connection opens before the old one closes, and for a moment both carry the
same frames.

What a client is promised about a frame across either depends on one thing:
whether the frame has an identity that is the same on every connection, and
what that identity lets the gateway and the client do.

- With a stable identity, a client recognises a frame it has already been
  given. A handover cannot double it.
- If that identity is also a **position** in a sequence someone keeps, the
  gateway can be asked for everything after it. A drop cannot lose it.
- With neither, a frame reaches whoever is connected when it passes.

### The three classes

| | **Positioned** | **Correlated** | **Passing** |
|---|---|---|---|
| Which frames | an event of the record, delivered on its resource's scope | the reply to a request | every other frame |
| Its identity | its place in that resource's record | the request it answers | none that outlives a connection |
| Across a handover | delivered once | delivered once | delivered once per connection |
| Across a drop | replayed: the client names, per scope, the last position it holds | sent again: the client names the replies it still awaits | **lost** |
| Bound | what the record still holds | how long the gateway retains a reply | none |
| Past the bound | `bus:resume-gap` names the scope | the request's own timeout | nothing: there is no signal |
| Reaches | every client holding the scope | the one client, and principal, that asked | every client subscribed |
| So a consumer may | apply each once, in order | await it inside its deadline | act only in ways that are safe when repeated, and when missed |

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
  are open is carried by both, and the client delivers both.
  *Held by `sdk/wire/passing-across-handoff`.*

Six channels carry events that are in the record and are passing all the
same: `yield:created`, `yield:updated`, `yield:cloned`, `yield:moved`,
`frame:entity-type-added` and `frame:tag-schema-added`. The record is kept
per resource, and these are delivered to every client on no scope, so they
have no position a client could resume from.
*Held by `packages/core/src/__tests__/bus-classification.test.ts`.*

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
  ([CACHE-SEMANTICS B13](../../packages/sdk/docs/CACHE-SEMANTICS.md), from
  the `reopened` row of [`specs/src/client/refresh.json`](../../specs/src/client/refresh.json)).
  *Held by `sdk/live/missed-while-down`, `sdk/live/refresh-reopened`, `sdk/live/reconnect`, `sdk/live/first-open`.*
- **A job's follower** asks for the job's status when the job has been
  silent ([JOBS.md](./JOBS.md#following-a-job)).
  *Held by `sdk/live/job-across-drop`.*

A row of the refresh table whose trigger is a passing channel may only
refetch, and `reopened` refetches whatever it does: the table's generator
refuses anything else.
*Held by `packages/core/src/__tests__/cache-refresh.test.ts`.*

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
  credential, or the one it has was refused. A refused credential is not
  sent again. The transport waits, with no request, and opens its stream
  when it is given another.
  *Held by `sdk/wire/unauthenticated`.*
- **`closed`** is terminal: the client was disposed.
  *Held by `sdk/wire/request-closed`.*

The timing a client keeps is [`specs/src/client/timing.json`](../../specs/src/client/timing.json),
from which every SDK generates its constants.

### Failures

Everything a server refused, and every request the gateway never answered,
is reported on the error stream as it is thrown to its caller, under a code
from [`specs/src/errors/codes.json`](../../specs/src/errors/codes.json).

- A refused stream is reported, and opened again no sooner than the
  refusal's `Retry-After`.
  *Held by `sdk/wire/stream-rate-limited`, `sdk/wire/unauthenticated`.*
- A gateway that cannot be reached fails an emit or a read as `unavailable`
  once its attempts are spent.
  *Held by `sdk/wire/unreachable`.*

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
  spent it fails as `rate-limited`.
  *Held by `sdk/wire/emit-rate-limited`, `sdk/wire/emit-budget-spent`.*
- **An emit refused outright fails** with the refusal's code, is reported
  on the error stream, and is not sent again.
  *Held by `sdk/wire/emit-refused`.*
- **`scope`**, when set, makes the emit a broadcast on that resource's
  scope: only subscribers holding the scope receive it.
  *Held by `sdk/wire/emit-counted`, `gateway/stream.test.ts`.*

## Requests

`busRequest(transport, operation, payload, timeoutMs?, signal?)` is an emit
that expects a correlated reply. The operation is its request channel; its
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

## Content and the gateway's own operations

Bytes do not ride the bus.

- An upload carries its bytes unchanged, each field under its own name, and
  resolves with the id the gateway answers.
  *Held by `sdk/wire/content-upload`.*
- An upload reports its progress as it is sent: how much has gone and how
  much there is, never less than it last said, and all of it by the time it
  resolves.
  *Held by `sdk/wire/upload-progress`.*
- An upload its caller cancels reports nothing more. Its connection is
  closed, nothing is reported on the error stream, and it is not sent again.
  *Held by `sdk/wire/upload-cancelled`.*
- A read returns a resource's bytes unchanged with their media type, whole
  or as a stream; a resource's description is what the gateway answers; and
  one that is not there fails as `not-found`.
  *Held by `sdk/wire/content-read`.*
- Each of the gateway's own operations is one request to its own path,
  carrying the client's token.
  *Held by `sdk/wire/gateway-operations`.*

## Telemetry

A client that exports telemetry exports the spans and the count
[`specs/src/sdk-telemetry/telemetry.json`](../../specs/src/sdk-telemetry/telemetry.json)
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

The cache ([CACHE-SEMANTICS](../../packages/sdk/docs/CACHE-SEMANTICS.md))
takes four things from the transport, and nothing else:

1. **Scope follows observation.** Observing something of a resource holds
   that resource's scope, and positioned events for it then arrive.
2. **An event refreshes what the cache holds** of what the event is about.
3. **A gap refreshes what the cache holds** of the scope the gateway could
   not cover.
4. **A reopened stream refreshes what the cache holds** of what passing
   events feed.

Which event refreshes what is [`specs/src/client/refresh.json`](../../specs/src/client/refresh.json).

## What this document is not

- Not an implementation guide. Each transport's source says how it keeps
  these promises.
- Not the HTTP wire. See [TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md).
- Not a channel inventory. See [CHANNELS.md](./CHANNELS.md).
- Not the bus's own semantics: naming, payload shapes, scoping, what rides
  the bus and what deliberately does not. See [EVENT-BUS.md](./EVENT-BUS.md).
