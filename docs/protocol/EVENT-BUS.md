# Event-Bus Protocol

This document describes the wire-level event protocol that every actor in Semiont speaks: channel naming, payload conventions, the gateway's identity injection, the trace-context carrier, and resource scoping. It is the contract that a transport (HTTP with server-sent events) implements and that an SDK hides behind typed methods.

If you only want to *use* the protocol from a script, you don't need this doc — read **[../../docs/builder/Usage.md](../builder/Usage.md)**, the SDK already wraps every channel pattern. Read this if you're:

- Building a transport
- Adding a new actor or worker that subscribes to channels directly via `eventBus.on(channel)`
- Debugging a bus-mediated round-trip with the [bus log](../../tests/e2e/docs/bus-logging.md)
- Adding a new channel to the EventMap

The authority is **[`specs/src/bus/registry.json`](../../specs/src/bus/registry.json)**; [`packages/core/src/bus-protocol.ts`](../../packages/core/src/bus-protocol.ts) (the `EventMap` type and `CHANNEL_SCHEMAS` map) and the Go and Rust equivalents are GENERATED from it — see "The registry is the authority" below. This doc is the prose explanation; the registry is the truth.

## What rides the bus, and the five things that deliberately do not

**The bus mediates subsystem messaging.** A request between two Semiont processes is a channel, a
payload and an envelope — not an HTTP call. That is what makes a subsystem relocatable: the
gateway's own handlers receive their frames from the broker through a queue group, so a handler
moving to another process costs no extra hop.

Five paths are deliberately not on the bus. They are the whole list; a sixth is a design change,
not an oversight.

| path | what | why not the bus |
|---|---|---|
| `POST /resources` (on the Archivist) | an upload: the bytes, and the resource they are recorded as | Bytes ride HTTP, never the bus. Streaming an arbitrarily large body as a frame is the wrong shape; and the Archivist, which writes the tree, records the resource in the same call, so the gateway makes no request of its own. |
| `GET /resources/:id/content` | byte reads from the Archivist | Same. |
| `GET /resources/:id/jsonld` | a resource's linked-data description, for an HTTP client following a content response's `Link: rel="describedby"` | A client dereferencing a link speaks HTTP. `browse:resource-requested` remains the bus-side read for everyone else. |
| `GET /events/:resourceId?fromSequence=N` | the `Last-Event-ID` replay behind `/bus/subscribe` | A bulk backlog read at connection setup, not an event. Bounded to one resource from one sequence, one customer. `browse:events-requested` remains the bus-side read for ordinary queries — the duplication is accepted and narrow. |
| `POST /api/tokens/agent` | a sidecar or worker buying an agent token | Bootstrapping a credential must not depend on the thing the credential is for. |

**Outside this rule by nature**, not exceptions to it: the trusted issuer (token endpoint, admin
API), datastores (Neo4j, Qdrant, Postgres), `/health` liveness probes, and OTLP telemetry.

The standing rule governing what may live on the Archivist's HTTP surface at all — *"this surface
serves the KB tree and each resource's linked-data description, and nothing else"* — is stated once, in
[the Archivist's API](../../specs/src/archivist/README.md). This
table is the system-level view; that document is the gate.

## Channel naming

Every channel is `verb:action` or `verb:action-state`. The prefix is one of the [eight verbs](flows/README.md), or one of a small set of cross-cutting domains.

| Prefix | Examples | Purpose |
|---|---|---|
| `yield:` | `yield:create`, `yield:created`, `yield:create-ok` | Writing: resources coming in, by upload, generation or cloning |
| `mark:` | `mark:create-request`, `mark:added`, `mark:create-ok` | Writing: annotations, and a resource's own facts |
| `bind:` | `bind:update-body`, `bind:body-updated` | Writing: what a reference refers to |
| `frame:` | `frame:add-entity-type`, `frame:entity-type-added` | Writing: the vocabulary (entity types and tag schemas) |
| `browse:` | `browse:resource-requested`, `browse:click` | Reading: the record; and viewer navigation |
| `match:` | `match:search-requested`, `match:search-results`, `match:resources-requested` | Reading: candidates for a reference, and resources by text |
| `gather:` | `gather:requested`, `gather:complete`, `gather:referenced-by-requested` | Reading: assembled context, and what refers to a resource |
| `beckon:` | `beckon:focus`, `beckon:sparkle` | Directing attention |
| `job:` | `job:create`, `job:report-progress`, `job:complete` | Delegated work ([JOBS.md](JOBS.md)) |
| `person:`, `session:` | `person:profiled`, `session:joined` | Who a DID belongs to; who is connected |
| `smelt:`, `weave:` | `smelt:settled`, `weave:applied` | The vector and graph projections reporting what they have applied |
| `bus:` | `bus:resume-gap` | The stream itself |
| `panel:`, `tabs:`, `nav:`, `shell:`, `settings:` | `panel:toggle`, `nav:push` | The Browser's interface; never on the wire |

State suffixes follow a small vocabulary:

- **No suffix** — a command or imperative event (`yield:create`, `mark:archive`)
- **`-requested`** — a read or async operation kicking off (`browse:resource-requested`, `gather:requested`)
- **past tense (`-ed`)** — a domain event the system records (`yield:created`, `mark:added`, `job:completed`)
- **`-result`** / **`-ok`** — successful response correlated with a request
- **`-failed`** — error response correlated with a request

`-ed` past-tense events are the **system of record**. They land in the event store, drive materialized views, and are what the rest of the system replays on read. The other shapes are transient — request/response chatter and UI signals that nobody persists.

## Payload categories

Each channel falls into one of five payload categories. The category tells you who validates the payload, who can emit it, and whether it gets persisted.

| Category | Schema source | Validated at gateway | Persisted | Example |
|---|---|---|---|---|
| **Domain event** (`StoredEvent<...>`; `EnrichedEvent<...>` where the EventStore enriches) | branded TypeScript wrapper | no — handlers emit | yes | `yield:created`, `mark:added`, `job:completed` |
| **Command** | OpenAPI schema (`components['schemas']`) | yes — `/bus/emit` | no | `yield:create`, `mark:archive`, `match:search-requested` |
| **Result / failure** | OpenAPI schema, wrapped as `{ response }` for some results; the `correlationId` rides the envelope | sometimes (whitelisted set) | no | `yield:create-ok`, `match:search-results`, `gather:failed` |
| **UI signal** | OpenAPI schema or `void` | yes when schema-typed | no | `beckon:hover`, `panel:toggle`, `mark:select-comment` |
| **SSE infrastructure** | OpenAPI schema | no | no | `bus:resume-gap` |

`CHANNEL_SCHEMAS` — declared in [the registry](../../specs/src/bus/registry.json), generated into `bus-protocol.ts` — maps every channel to its OpenAPI schema name (or `null` when validation isn't applicable — `StoredEvent` wrappers, `void` signals, inline wrapper types such as `{ response: T }`). The gateway's `/bus/emit` route validates against the same registry entries and rejects payloads that don't validate.

### Wire unions discriminate

A wire union whose members are told apart by a field declares that field: an
OpenAPI `discriminator` with an explicit `mapping`. This is a protocol property, not a
per-schema accident:

| union | discriminant |
|---|---|
| `JobCreateCommand`, `JobCompleteCommand`, `JobFilter`, `JobQueuedEvent` | `jobType` — `mark` / `yield` |
| `MarkJobParams` | `motivation` — one named schema for each of the five |
| `JobProgressMessage` | `code` — one named schema per code |
| `Agent` | `@type` — `Person` / `Organization` / `Software` |
| `AnnotationBody` | `type` |
| `DirectoryEntry` | `type` — `file` / `dir` |
| `ExtractionOutcome` | `kind` — `extracted` / `declined` |

What that buys each generated client: **TypeScript** narrows with an exhaustive
`switch` whose `default` is `never` — an unhandled member is a compile error, and no
consumer needs a cast. **Go** gets typed variants with `Discriminator()` /
`ValueByDiscriminator()` instead of an opaque `json.RawMessage` — and note that the
positional `As*()` accessors remain bare unmarshals that succeed on the wrong
variant; `ValueByDiscriminator()` is the honest dispatch.

Go has no `never`, so exhaustiveness there is held by **census pins** instead of the
compiler: the launcher's progress-code → English map (`yield.go`) has a `default: ""`
that degrades silently on an unhandled code, so `TestProgressTextCoversEveryCode`
feeds it every wire code and requires non-empty text for each. A new code fails that
pin, not a user's terminal. When adding a member to any union above, that is the
pattern: TS gets it free from the `never` default; Go needs its census extended.

**`JobResult` has no discriminant, by design.** It is what a job's record holds, one of
three: a `mark` job's counts, the resource a `yield` job made, or a decline. The record's
type says which job it answers, and the three share no member, so each is told from the
others by what it alone carries: `found`, `resourceId` or `declined`. In TypeScript that
is `'found' in result`. A completion is narrower. `job:complete` is told apart by
`jobType` and carries its verb's result, a `MarkJobResult` or a `YieldJobResult`: its
verb's own result or a decline, and the decline is the one with `declined`.

## Identity: `_userId` and `_roles` are gateway-stamped

Commands that mutate state need to know who is making them. The convention: clients **never** set `_userId` or `_roles` themselves. The `/bus/emit` gateway verifies the bearer token, builds the principal from its claims, and stamps both onto the payload before forwarding it onto the bus — clearing whatever a caller wrote there first:

```rust
// apps/gateway/src/routes/bus.rs
payload.remove("_roles");
payload.insert("_userId".to_owned(), json!(principal.did));
if let Some(roles) = principal.roles.as_ref().filter(|r| !r.is_empty()) {
    payload.insert("_roles".to_owned(), json!(roles));
}
```

`_userId` is the **verified emitter** — the one identity fact on an event, and the only identity a handler may honour. Beside that stamp the gateway emits `person:profile` when the emitter is a person, carrying the display name it just verified: gateway-produced like the stamp itself, never client-set, and recorded only when the name has changed. It is the one thing the gateway sends that is a fact *about* an identity rather than an act, and it is why an artifact can carry a bare DID and still be read as a person's name. Every other provenance fact is derived from it: who *requested* a piece of work is read from the job the write cites (`jobId`), joined to the dispatcher's own `job:assigned` record, never from anything the emitter wrote in the payload. A person's DID is `did:web:<site domain>:users:<subject>`, the subject being the issuer claim `[identity] subjectClaim` selects; a software agent's is `did:web:<site domain>:agents:<provider>:<model>` — the same authority and the same shape, so a person's act and an agent's act are recorded the same way.

`_roles` is the token's capabilities (a worker's `WORKER_ROLE`): a **transient** authorization fact the dispatcher reads to authorize a `job:claim`. It is never persisted as provenance.

In the schema, `_userId` is **optional** with the canonical description "Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this." Handlers reading the channel can rely on `_userId` being present for any payload that came through the gateway — and treat its absence as a malformed event: the Stower refuses a `yield:create` that carries none.

The underscore prefix is the convention's marker — anything starting with `_` on a payload is gateway plumbing, not consumer-supplied data. This applies uniformly across every command schema that needs auth context: `MarkCommitCommand`, `MarkArchiveCommand`, `YieldCreateCommand`, `YieldCloneCreateCommand`, `JobCompleteCommand`, etc.

## Correlation: request/response over a fan-out bus

> **Where the bus lives.** Inside the gateway the bus is a *driver seam*, below the wire this document describes: the in-process driver keeps the fan-out inside one gateway process, and `[signal] type = "nats"` swaps in a NATS driver that fans out over core subjects across replicas. Neither the wire nor anything below changes — the gateway injects identity, applies entitlement, and mints correlation the same way under both, so this protocol and every SDK client are unaffected by the choice. See [Signal Plane configuration](../operator/administration/CONFIGURATION.md).

The bus is fan-out: every subscriber to a channel sees every event on it. Request/response semantics are layered on top via a `correlationId`:

1. The caller generates a UUID and emits a request (e.g. `match:search-requested`) with that `correlationId` on the frame's envelope — beside the payload, never inside it — and its `clientId`.
2. The handler does its work and emits the response (`match:search-results` or `match:search-failed`) carrying the **same** `correlationId` on its envelope.
3. The gateway delivers the response only to the connections of the client that made the request (the request's emit *claimed* the id), and the caller matches it by `correlationId`.

`busRequest` ([packages/core/src/bus-request.ts](../../packages/core/src/bus-request.ts)) implements this pattern uniformly. It lives in `@semiont/core`, next to the bus protocol, so the SDK *and* the services share one helper. You call it with the **operation** — the request channel — and a payload; it mints the `correlationId`, looks the reply channels up from the registry, emits, and resolves the awaited reply:

```ts
import { busRequest } from '@semiont/core';

// The operation is named by its request channel. The result and failure
// channels are looked up from BUS_OPERATIONS, and the return type is inferred.
const resource = await busRequest(semiont.transport, 'browse:resource-requested', { resourceId });
```

Two declarations make this work, and together they rule out a whole bug class (a reply channel that's forgotten from the bridged set, which fails as a silent 30 s timeout):

- **The operations registry.** [`BUS_OPERATIONS`](../../packages/core/src/bus-operations.ts) declares every request/reply operation **once** as a triple — `request → { result, failure, progress? }`. `busRequest` reads the request channel's entry to find its reply channels (so a caller can't pass a mismatched or unbridged pair), and the bridged-reply set is *derived* from it (see [Fan-in](#fan-in-sse-bridging)). The return type is inferred from the result channel — callers never write `<TResult>`.

- **The reply-shape standard.** Every reply carries the request's `correlationId` on its envelope, and its payload is one of three shapes:
  - `{ response: T }` — success with data → resolves to `T`.
  - `{}` — success, no data → resolves to `void`.
  - `CommandError` — failure → rejects with `BusRequestError` whose `code` is the failure's own `CommandError.code` promoted to the client vocabulary (`bus.not-found`, `bus.peer-unavailable`, `bus.unauthorized`, `bus.none-pending`), or `bus.rejected` when the failure carries none, per the [SDK error model](../builder/Usage.md#error-handling).

  `busRequest` reads `e.response`, so **every reply handler must carry the request's `correlationId` onto its reply's envelope and put its data under `response`** — a reply without the id hangs the caller until `bus.timeout`. The uniformity is exactly what lets the return type be derived from the registry instead of hand-annotated.

  A reply may also state what it answers for beside `response`, by stating a property of its request again: `gather:complete` carries the `annotationId` its request did. [`REPLY_NAMES`](../../packages/core/src/bus-operations.ts), generated beside `BUS_OPERATIONS`, lists those properties for every operation. Each list is what the reply's schema requires, without `response`; the generator refuses one the request's schema does not state.

## Trace context: the `_trace` carrier

Distributed traces ride on a relayed frame's payload. The `_trace` field carries the W3C `traceparent` (and optional `tracestate`) so spans started by handlers become children of the originating span:

```ts
interface TraceCarrier {
  traceparent: string;     // W3C: '00-<traceId>-<spanId>-<flags>'
  tracestate?: string;     // vendor extensions
}
```

The two directions carry it differently:

- **Emit.** A client's `POST /bus/emit` carries the active span in the `traceparent` request header (`getActiveTraceparent()` in `@semiont/observability` reads it); the payload is left alone.
- **Receive.** An SSE event has no headers of its own, so the gateway's stream route writes the trace context onto `payload._trace`. On receipt, `extractTraceparent(payload)` pulls and removes the field, returning the carrier so the handler runs under `withTraceparent(carrier, ...)`.

The field is **internal plumbing**: subscribers see it stripped before delivery, and most consumer code never needs to touch it. A new wire transport mirrors the pattern — propagate on emit, extract before subscriber dispatch.

For details on how `_trace` correlates with the grep-friendly `busLog` timeline and the OpenTelemetry span tree, see **[../operator/administration/OBSERVABILITY.md](../operator/administration/OBSERVABILITY.md)**.

## Resource scoping

A channel reaches clients in one of two **disjoint** delivery disciplines:

- **Global fan-out** — forwarded to every connected client, which filters by `correlationId` (correlation replies like `match:search-results`) or just reacts (KB-global events like `frame:entity-type-added`). This is the *bridged* set (see [Fan-in](#fan-in-sse-bridging)).
- **Resource-scoped** — delivered only to clients that have *joined* a resource's scope via `subscribeToResource(id)`. Publishers emit on a scoped bus (`eventBus.scope(resourceId)`); the HTTP transport carries each subscription as a `{scope, channels, lastEventId?}` entry in the `POST /bus/subscribe` matrix, and scoped SSE frames are tagged with their originating scope. One connection holds many resource scopes at once — distinct resources compose. On the client, subscribing to a resource's `browse.*` live queries attaches a ref-counted scope that auto-detaches on the last unsubscribe — *freshness follows observation*.

Which discipline a channel has is declared, not computed: the registry gives each such channel an `audience` of `everyone` or `scoped`, and the two generated lists (`BRIDGED_BROADCASTS` and `RESOURCE_SCOPED_CHANNELS`, in [bridged-channels.ts](../../packages/core/src/bridged-channels.ts)) are those declarations. The scoped channels are the events of the record that concern one resource: annotations, a resource's own facts, its renditions, and its jobs. The events of the record that concern the whole knowledge base (`frame:entity-type-added`, `yield:created` and their siblings) go to everyone.

**A channel has one audience.** A channel delivered on both the global subscription and a scoped one would arrive twice, with different ids, and be duplicated on the client's bus. One declaration per channel makes that unrepresentable, and an invariant test (`BRIDGED_CHANNELS ∩ RESOURCE_SCOPED_CHANNELS === ∅`) backstops it.

`job:complete` and `job:fail` are delivered to everyone and carry no scope. The caller that dispatched a job filters by its `jobId`, and a viewer filters the same stream by `resourceId`, so a client that is both receives each once.

Per-caller progress and search results are *not* scoped — they're correlation-shaped replies that publish globally and the caller filters by `correlationId`. Resource scoping is for genuine multi-participant fan-out: events that *every* viewer of a resource should see.

The rule, by event kind:

| Event kind | Scoped? | Why |
|---|---|---|
| Command (one handler) | **No** | No fan-out to narrow. Handler subscribes by channel name; that's sufficient. |
| Correlation-ID response (e.g. `mark:create-ok`) | **No** | Caller filters by `correlationId`. Scope adds nothing and would require the emitter to know which resource the caller is on. |
| Resource-bound broadcast (persisted domain events, actor progress meant for all viewers) | **Yes** | Many viewers, only some care. Scope narrows fan-out to viewers of that resource. |
| System-wide broadcast (`frame:entity-type-added`, `beckon:*`) | **No** | Concerns everyone — not about a specific resource. |

## Persistence: the system of record

Domain events (past-tense `-ed` channels) are the only events that get appended to the event store. They're typed as `StoredEvent<EventOfType<...>>` in the EventMap rather than as OpenAPI schemas — they carry storage metadata (sequence number, stream position) on top of the domain payload.

The channels the registry marks `"enriched": true` are typed `EnrichedEvent<EventOfType<...>>`: the stored event plus, at the top level, the annotation as it stands in the view, which the EventStore attaches after materializing and before publishing. Subscribers read it to update a cached annotation in place rather than refetch — `mark:body-updated`, for instance, carries only the body operations, not the annotation they produce. It is optional: enrichment declines when the view no longer holds the annotation. **The flag is the list** — the generator derives every stored event's type from its `event` and `enriched`, and the generated `ENRICHED_EVENT_TYPES` is what the enricher dispatches on, so a flag without a case fails to compile rather than silently never arriving.

`PERSISTED_EVENT_TYPES` in [persisted-events.ts](../../packages/core/src/persisted-events.ts) is the list of channels the event-sourcing layer treats as durable. It is generated from the registry's `storedEvent` channels, so adding a domain event means adding its channel there, with the schema of its `payload`.

Commands, results, and UI signals are transient. They flow across the bus, drive handlers, and disappear. Only their downstream `-ed` events get recorded.

## Fan-in: SSE bridging

The SDK's `SemiontClient` owns a local `EventBus`; the HTTP transport bridges wire events into it. `BRIDGED_CHANNELS` in [bridged-channels.ts](../../packages/core/src/bridged-channels.ts) is the set the transport forwards. It is **derived**, not listed by hand: every operation's reply channels (result + failure + optional progress) come from the `BUS_OPERATIONS` registry, plus the registry's `audience: everyone` set — the non-request/reply minority (KB-global domain events like `frame:entity-type-added`, UI signals like `beckon:*`, and infra like `bus:resume-gap`). Deriving the reply set from the registry is what makes "a reply channel forgotten from the bridged set" — a silent timeout — unrepresentable.

### Where the invariants are enforced

Three layers, deliberately, because each catches what the others structurally cannot:

| Layer | Where | Catches |
|---|---|---|
| **Source** | [validate-registry.mjs](../../scripts/bus/validate-registry.mjs), run by both generators before they emit | undeclared operation channels, a reply owned by two operations, a non-emittable request, and a reply channel also given an `audience` (the double-delivery shape) — reported against the registry line you typed |
| **Compile time** | `satisfies` clauses in the generated TypeScript | an unknown channel, a missing payload binding, a schema name that isn't in the OpenAPI types |
| **Test time** | [bus-invariants.test.ts](../../packages/core/src/__tests__/bus-invariants.test.ts) and [bridged_test.go](../../packages/sdk-go/bus/bridged_test.go) | duplicates in the bridged set, the frozen-snapshot equality, bridged ∩ persisted, and — in Go, which has no `satisfies` — the reply-is-bridged and request-is-emittable properties |

The Go tests overlap the TypeScript ones on purpose. Both languages generate from one registry, so they are a second opinion rather than the only guard; that redundancy is the point, because an artifact checked only against the thing that generated it can agree with a mistake indefinitely.

The HTTP transport wires this once, for the life of its stream: each frame it receives on a bridged or a resource-scoped channel crosses to the client's bus with its envelope, the correlation id carried. See [`http-transport.ts`](../../packages/http-transport/src/transport/http-transport.ts).

This is the *fan-in* set — what the transport pushes onto the client's bus. The set the client emits is open-ended and uses `transport.emit(channel, payload)` directly.

## Wire format: the bus log

When `__SEMIONT_BUS_LOG__ = true` (browser) or `SEMIONT_BUS_LOG=1` (Node), every cross-transport event prints one grep-friendly line:

```
[bus EMIT] mark:create-request [scope=res-1] [cid=a89a670a] [trace=8f3ca4ed] {...}
[bus RECV] mark:create-ok      [scope=res-1] [cid=a89a670a] [trace=8f3ca4ed] {...}
[bus SSE]  mark:added          [scope=res-1] [cid=a89a670a] [trace=8f3ca4ed] {...}
[bus PUT]  content                        [cid=a89a670a] [trace=8f3ca4ed] {size: 14823, ...}
[bus GET]  content                        [cid=a89a670a] [trace=8f3ca4ed] {size: 14823, ...}
```

Five operations, all logged at transport-contract choke points (not in the SDK's namespace methods or the `ActorStateUnit` SSE machinery — those ride on the transport):

| Op | Site |
|---|---|
| `EMIT` | `HttpTransport.emit()`, gateway `/bus/emit` route |
| `RECV` | HttpTransport SSE-side fan-in |
| `SSE` | Gateway `Connection::deliver` in `apps/gateway/src/routes/stream.rs` (on stderr) |
| `PUT` | `HttpContentTransport.putBinary()` + matching gateway route |
| `GET` | `HttpContentTransport.getBinary()` / `getBinaryStream()` + matching gateway route |

The full capture API and per-test fixture are in **[../../tests/e2e/docs/bus-logging.md](../../tests/e2e/docs/bus-logging.md)**.

A clean round-trip across the wire shows a contiguous EMIT → EMIT → SSE → RECV pattern. Missing lines diagnose with surgical precision: no gateway `EMIT` means the request never reached the server (auth, CORS, network); no gateway `SSE` means the handler never produced a result; no Browser `RECV` means the SSE bytes never parsed.

## How the SDK shapes the protocol

The SDK doesn't *replace* the bus — it wraps the channel-call patterns so consumers don't write `correlationId` glue and `bus.stream(...).pipe(filter(...))` for every operation. Three layers of abstraction sit on top:

**1. `ITransport`** ([packages/core/src/transport.ts](../../packages/core/src/transport.ts)) — the contract every transport implements: `emit(channel, payload, scope?)`, `stream(channel)`, `subscribeToResource(id)`, `bridgeInto(bus)`. Transport-neutral; `HttpTransport` (HTTP+SSE) implements it.

**2. `busRequest`** ([packages/core/src/bus-request.ts](../../packages/core/src/bus-request.ts)) — the request/response abstraction. Called with the **operation** (request channel) and a payload; it mints the `correlationId`, looks the result/failure channels up from `BUS_OPERATIONS`, applies a timeout, infers its return type from the result channel, and resolves to the response or rejects with a typed `BusRequestError`. Every namespace method that needs a round-trip is a thin call into this helper. (It lives in `@semiont/core`, so the services use the same path.)

**3. Verb namespaces** (`semiont.mark.*`, `semiont.match.*`, `semiont.browse.*`, etc.) — the typed entry points. Each method picks the right channels for its operation, brands ID inputs, and returns the right shape (`Promise`, `StreamObservable`, `CacheObservable`). The channel choice is hidden behind the method name — `semiont.match.search(...)` knows it emits `match:search-requested` and resolves on `match:search-results` / `match:search-failed`.

Three legitimate paths to the bus, each suited to a distinct case:

- **Typed namespace method** (preferred) — `client.mark.annotation(...)`, `client.beckon.hover(...)`. Types catch mistakes; channel names and correlation IDs are internal. The right path whenever a namespace covers the operation.
- **`session.subscribe(channel, handler)`** — channel-by-name observation. The sanctioned escape hatch when the channel name is dynamic (`useEventSubscription` in React, an agent watching `mark:added` for collaborator activity) or no namespace exposes a typed listener for the channel you care about. A channel delivered on a resource's scope is subscribed to with its resource, `session.subscribe(channel, resourceId, handler)`, which holds that scope for as long as it listens.
- **Direct `client.bus.on(channel)` / `client.transport.emit(channel, ...)`** — the lowest-level path, for workers and actors that *are* the handlers (Stower, Gatherer, Matcher, Smelter inside `@semiont/make-meaning` use this), for RxJS operator composition on a channel stream, or for prototyping new operations not yet wrapped by a namespace.

The three paths are documented end-to-end (with code shapes and call-site examples) in [`docs/builder/REACTIVE-MODEL.md`](../builder/REACTIVE-MODEL.md#three-paths-to-the-bus). The bus surface is *not* `@internal` — it's a real surface for advanced and worker use — but the typed namespaces are the canonical entry point for everything else. If you find yourself writing `transport.emit(channel, ...)` from application code, the right move is usually to reach for the namespace, or — if no namespace covers your case — to add one.

## The registry is the authority; every language is generated

`bus-protocol.ts` and `bus-operations.ts` are **generated files** — do not edit
them. The authority is **[`specs/src/bus/registry.json`](../../specs/src/bus/registry.json)**:
every channel, the payload it carries, and the request/reply operation triples.
Two generators read it:

| Output | Generator |
|---|---|
| `packages/core/src/bus-protocol.ts`, `bus-operations.ts`, `bus-classification.ts` | `node scripts/bus/generate-ts.mjs` |
| `packages/sdk-go/bus/{channels,operations}_gen.go` | `node scripts/bus/generate-go.mjs` |
| The Rust SDK's channel and operation tables | its build script, [`packages/sdk-rust/build.rs`](../../packages/sdk-rust/build.rs), on every build |
| `packages/sdk-python/src/semiont/channels.py`, `operations.py` | `node scripts/bus/generate-python.mjs` |

```sh
npm run generate:bus          # regenerate TypeScript and Go
npm run generate:bus:check    # verify without writing (what CI runs)
npm run generate:python       # regenerate every module the Python SDK takes from specs/, these two among them
npm run generate:python:check # verify without writing (what CI runs)
```

Hand-written TypeScript that the registry cannot express — runtime-only UI
types like `AnchorRect` (DOM geometry, callbacks) — lives in the companion
module `packages/core/src/bus-ui-types.ts`, which the generated file imports
and re-exports.

Payload *schemas* live in the OpenAPI components — the registry only
names which schema each channel carries. Channels whose payload is
TypeScript-only (DOM geometry, callbacks) are excluded from the Go output:
they never cross the wire.

### The channel classification (`CHANNEL_ATTRS`)

`bus-classification.ts` is a third TypeScript output of the same generator —
one entry per channel, its attributes read straight off registry facts, so a
boundary that needs to reason about a channel does not re-derive them and
cannot drift from the registry:

- **`recorded`** — whether the channel lands in the event log (mirrors
  `PERSISTED_EVENT_TYPES`).
- **`direction`** — `outbound` (emitted toward the hub), `inbound` (delivered
  from it), or `in-process` (never on the wire).
- **`writes`** — on a channel that is emitted: whether emitting it changes the
  knowledge base.
- **`delivery`** — the channel's delivery class: what a subscriber is promised
  about a frame on it when its stream drops, or is handed to another
  ([TRANSPORT-CONTRACT.md § Delivery](./TRANSPORT-CONTRACT.md#delivery)).
  `correlated` for an operation's result and failure, which reach the client
  that asked and are sent again while retained; `positioned` for an event of
  the record delivered on its resource's scope, which is replayed from where
  a client left off; `passing` for every other channel that crosses the wire,
  which nothing replays. Absent on an in-process channel, and only there.

  **Who receives a frame is the `audience` axis; `delivery` is what each
  receiver is promised.** Six channels are `recorded` and `passing` at once:
  events of the record that every client hears, on no scope, and so with no
  position to resume from.

The attributes are independent, and adding an operation to the registry
classifies its channels with no hand edit. Consume them through
`channelAttrsOf(channel)`.

**Generated attributes, declared axes.** What `CHANNEL_ATTRS` carries is
*derived* from what the registry declares: `operations`, `kind` (`command` |
`event`), `audience` (`everyone` | `scoped` | `declared`), `inProcess`,
`effect`, and which channels are events of the record. A channel that names no
class refuses to generate — there is no default, because a silent fallthrough
can classify a channel such as `job:queued` as in-process and starve every
worker. Declare the axis; read the attribute.

**There is no progress class.** An operation declares a `result` and a
`failure`, and that is all. Incremental reporting uses the job lifecycle family
instead — see *Two identities* below.

### Two identities: routing versus domain

A frame can be matched to what it belongs to in two different ways, and the
system uses both. Keeping them straight is what makes the `delivery` axis
legible.

| | routing identity | domain identity |
|---|---|---|
| the key | `correlationId` | `jobId`, `resourceId`, `annotationId` |
| where it rides | the frame's **envelope** | inside the **payload** |
| who sets it | `busRequest`, per request | the domain, per thing |
| matched by | the gateway ledger, before delivery | the consumer, after delivery |
| the `delivery` axis | classifies these | says nothing about these |

A routing key is a wire concern: it exists to pair one reply with one request
and never enters a channel's domain type. A domain key is a fact about the
thing itself, and outlives any single exchange.

The job lifecycle is the only case of the second, and the reason there is no
progress class: an operation's reply arrives once, and work that reports as it
goes is a job rather than a longer request. `job:create` is an
operation — one request, one correlated `job:created` reply carrying a
`jobId` — and that exchange is over. What the worker reports after it
(`job:report-progress`, `job:complete`, `job:fail`) is a **global broadcast
carrying no `correlationId`**, which consumers filter by domain key: a
dispatching caller by `jobId` (it awaited one job), a resource viewer by
`resourceId` (it wants anything happening to what it shows). (`job:start`
carries no `correlationId` either, but is `audience: declared`: it reaches the
Stower, whose `job:started` reaches the resource's viewers.) So job progress
is not an operation reply that the `delivery` axis failed to classify. It is a
different mechanism, deliberately, and `delivery` does not describe it. The
job lifecycle itself is specified in [JOBS.md](JOBS.md).

**Do not confuse `delivery` with the SSE fan-in disciplines** in [Resource
scoping](#resource-scoping) above: `delivery` classifies a channel's *routing
intent* at the hub (how the gateway's Signal Plane and its correlation ledger
treat it), while "global-bridged vs resource-scoped" is the *transport's* choice
of which SSE subscription carries a wire event to a client. Related, not the
same axis.

Nothing regenerates automatically. The `Generated Artifacts (drift)` CI job
and `scripts/ci/local-build.sh` both fail if the committed output disagrees
with the registry, naming the command to run.

## Adding a new channel

The compile-time discipline is strict by design. A new channel requires changes in two places (the registry and the OpenAPI schema), plus an SDK method to call it:

1. **The registry** ([`specs/src/bus/registry.json`](../../specs/src/bus/registry.json)) — add the channel with its payload: a `shape` (`schema`, `envelope`, `storedEvent`, `void` or `empty`) and the OpenAPI schema it names (`schema`, or `payload` for a stored event — one that mutates an annotation also takes `"enriched": true`, and one that belongs to no resource `"system": true`), and its `validate` entry: the schema the `/bus/emit` route enforces, or `null` for non-validated. Then run `npm run generate:bus`, which writes the `EventMap` and `CHANNEL_SCHEMAS` entries in both languages. The generated `satisfies Record<EventName, ...>` clause still fails the typecheck if the two maps disagree, and `validate-registry.mjs` refuses a payload stated any other way.
2. **The routing**, for SSE delivery: a request/reply operation is declared as an `operations` entry in the **registry** (generated into `BUS_OPERATIONS`) (which *derives* its reply channels into `BRIDGED_CHANNELS`); a non-request/reply broadcast that should reach every client is declared **`audience: everyone`** in the registry (and one that should reach only viewers of a resource, `audience: scoped`). You never hand-edit `BRIDGED_CHANNELS` — replies are derived, and broadcasts are registry data. Each list has its own completeness check, an equality test pins the derived bridged set, and `validate-registry.mjs` refuses a broadcast entry that is really an operation's reply.

Then for the OpenAPI schema:

3. Add the schema file to `specs/src/components/schemas/`.
4. Reference it from the right path file under `specs/src/paths/` (if the channel has an HTTP entry point too).
5. Run `npm run generate:openapi --workspace=@semiont/core` to bundle and regenerate types.
6. Rebuild `@semiont/core`.

And for the SDK:

7. Add a namespace method that wraps `transport.emit(channel, ...)` or `busRequest(...)` for the new operation.
8. Update [docs/builder/Usage.md](../builder/Usage.md) under the right verb.

Skipping any step is caught at build time — `CHANNEL_SCHEMAS`'s `satisfies` clause and `validate-registry.mjs` make incomplete additions fail loud and clear.

## See also

- **[CHANNELS.md](./CHANNELS.md)** — channel inventory: persisted events, ephemeral signals, correlation responses, resource broadcasts, bridged channels.
- **[JOBS.md](./JOBS.md)** — the job protocol: the job record and its states, the `job:*` channels the dispatcher answers, claims, retries, cancellation.
- **[TRANSPORT-CONTRACT.md](./TRANSPORT-CONTRACT.md)** — abstract `ITransport` behavioral guarantees every transport must honor.
- **[TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md)** — HTTP+SSE wire format; the `/bus/emit` and `/bus/subscribe` contract.
- **[`specs/src/bus/registry.json`](../../specs/src/bus/registry.json)** — the authority: channels, payloads, operations.
- **[`packages/core/src/bus-protocol.ts`](../../packages/core/src/bus-protocol.ts)** — GENERATED `EventMap` and `CHANNEL_SCHEMAS`.
- **`packages/sdk-go/bus/`** — GENERATED Go channel constants and operation registry.
- **[`packages/core/src/event-bus.ts`](../../packages/core/src/event-bus.ts)** — the in-process `EventBus` and `ScopedEventBus` implementation.
- **[../../tests/e2e/docs/bus-logging.md](../../tests/e2e/docs/bus-logging.md)** — the bus log format and capture API.
- **[../../docs/builder/Usage.md](../builder/Usage.md)** — the namespace tour with worked examples per verb.
- **[../operator/administration/OBSERVABILITY.md](../operator/administration/OBSERVABILITY.md)** — how `_trace` correlates with OpenTelemetry spans and the `busLog` grep timeline.
- **[flows/README.md](flows/README.md)** — the eight verbs that organize the channel namespace.
