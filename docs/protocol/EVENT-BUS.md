# Event-Bus Protocol

This document describes the wire-level event protocol that every actor in Semiont speaks: channel naming, payload conventions, the gateway's identity injection, the trace-context carrier, and resource scoping. It is the contract that the transport layer (HTTP+SSE, in-process, future gRPC) implements and that the SDK hides behind typed namespace methods.

If you only want to *use* the protocol from a script, you don't need this doc — read **[../../packages/sdk/docs/Usage.md](../../packages/sdk/docs/Usage.md)**, the SDK already wraps every channel pattern. Read this if you're:

- Building a new transport (e.g. `LocalTransport` for in-process, a hypothetical `GrpcTransport`)
- Adding a new actor or worker that subscribes to channels directly via `eventBus.get(channel)`
- Debugging a bus-mediated round-trip with the [bus log](../../tests/e2e/docs/bus-logging.md)
- Adding a new channel to the EventMap

The authoritative TypeScript definition is **[`packages/core/src/bus-protocol.ts`](../../packages/core/src/bus-protocol.ts)** — the `EventMap` type and the `CHANNEL_SCHEMAS` map. This doc is the prose explanation; the source is the truth.

## Channel naming

Every channel is `verb:action` or `verb:action-state`. The verb is one of the eight flows ([flows/README.md](flows/README.md)) plus a small set of cross-cutting domains.

| Prefix | Examples | Purpose |
|---|---|---|
| `frame:` | `frame:add-entity-type`, `frame:entity-type-added` | Schema-layer vocabulary (entity types; future tag schemas, relation types) |
| `yield:` | `yield:create`, `yield:created`, `yield:create-ok` | Resource creation, update, move, clone |
| `mark:` | `mark:create`, `mark:added`, `mark:create-ok` | Annotation CRUD, AI assist |
| `bind:` | `bind:initiate`, `bind:body-updated` | Reference resolution |
| `match:` | `match:search-requested`, `match:search-results` | Multi-source candidate retrieval |
| `gather:` | `gather:requested`, `gather:complete` | Context assembly |
| `browse:` | `browse:resource-requested`, `browse:click` | Reads + UI navigation |
| `beckon:` | `beckon:hover`, `beckon:focus`, `beckon:sparkle` | Attention coordination |
| `job:` | `job:start`, `job:report-progress`, `job:complete` | Worker job lifecycle |
| `panel:`, `tabs:`, `nav:`, `shell:` | `panel:toggle`, `nav:push` | App-shell UI events (frontend only) |
| `settings:` | `settings:theme-changed`, `settings:locale-changed` | Frontend preferences |
| `bus:`, `stream-`, `replay-` | `bus:resume-gap`, `stream-connected` | SSE infrastructure |

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
| **Domain event** (`StoredEvent<...>`) | branded TypeScript wrapper | no — handlers emit | yes | `yield:created`, `mark:added`, `job:completed` |
| **Command** | OpenAPI schema (`components['schemas']`) | yes — `/bus/emit` | no | `yield:create`, `mark:archive`, `match:search-requested` |
| **Result / failure** | OpenAPI schema or inline `{ correlationId, ... }` | sometimes (whitelisted set) | no | `yield:create-ok`, `match:search-results`, `gather:failed` |
| **UI signal** | OpenAPI schema or `void` | yes when schema-typed | no | `beckon:hover`, `panel:toggle`, `mark:selection-changed` |
| **SSE infrastructure** | inline | no | no | `stream-connected`, `bus:resume-gap` |

`CHANNEL_SCHEMAS` in [bus-protocol.ts](../../packages/core/src/bus-protocol.ts) maps every channel to its OpenAPI schema name (or `null` when validation isn't applicable — `StoredEvent` wrappers, `void` signals, compound inline types). The `/bus/emit` route reads this map and rejects payloads that don't validate.

## Identity: `_userId` is gateway-injected

Commands that mutate state need to know who's making them. The convention: clients **never** set `_userId` themselves. The HTTP gateway reads the authenticated user from the JWT and stamps `_userId` onto the payload before forwarding to the in-process bus:

```ts
// apps/backend/src/routes/bus.ts
const user = c.get('user') as User | undefined;
if (user) {
  payload._userId = userToDid(user);
}
```

In the schema, `_userId` is **optional** with the canonical description "Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this." Handlers reading the channel can rely on `_userId` being present for any payload that came through the gateway — and treat its absence as a malformed event:

```ts
private async handleYieldCreate(event: EventMap['yield:create']): Promise<void> {
  if (!event._userId) {
    throw new Error('yield:create missing _userId (gateway injection)');
  }
  const uid = makeUserId(event._userId);
  // ...
}
```

The underscore prefix is the convention's marker — anything starting with `_` on a payload is gateway plumbing, not consumer-supplied data. This applies uniformly across every command schema that needs auth context: `MarkCreateCommand`, `MarkArchiveCommand`, `YieldCreateCommand`, `YieldCloneCreateCommand`, `JobCompleteCommand`, etc.

In-process transports (e.g. `LocalTransport` from `@semiont/make-meaning`) emit directly without a gateway hop. They're responsible for setting `_userId` themselves before publishing — if the call originated from an authenticated context, the local emit code must thread the user identity through.

## Correlation: request/response over a fan-out bus

The bus is fan-out: every subscriber to a channel sees every event on it. Request/response semantics are layered on top via a `correlationId`:

1. The caller generates a UUID and emits a request (e.g. `match:search-requested`) with `correlationId` in the payload.
2. The handler does its work and emits the response (`match:search-results` or `match:search-failed`) carrying the **same** `correlationId`.
3. The caller filters the response channel by `correlationId` to receive only its own answer.

`busRequest` ([packages/core/src/bus-request.ts](../../packages/core/src/bus-request.ts)) implements this pattern uniformly. It lives in `@semiont/core`, next to the bus protocol, so the SDK *and* in-process workers share one helper. You call it with the **operation** — the request channel — and a payload; it mints the `correlationId`, looks the reply channels up from the registry, emits, and resolves the awaited reply:

```ts
const { annotationId } = await busRequest(bus, 'mark:create-request', { resourceId, request });
//                                              └ operation key       result/failure looked up from BUS_OPERATIONS;
//                                                                    return type inferred — no <TResult> annotation
```

Two declarations make this work, and together they retire a whole bug class (a reply channel that's forgotten from the bridged set, which fails as a silent 30 s timeout):

- **The operations registry.** [`BUS_OPERATIONS`](../../packages/core/src/bus-operations.ts) declares every request/reply operation **once** as a triple — `request → { result, failure, progress? }`. `busRequest` reads the request channel's entry to find its reply channels (so a caller can't pass a mismatched or unbridged pair), and the bridged-reply set is *derived* from it (see [Fan-in](#fan-in-sse-bridging)). The return type is inferred from the result channel — callers never write `<TResult>`.

- **The reply-shape standard.** Every reply is one of three shapes, all keyed by `correlationId`:
  - `{ correlationId, response: T }` — success with data → resolves to `T`.
  - `{ correlationId }` — success, no data → resolves to `void`.
  - `{ correlationId } & CommandError` — failure → rejects with `BusRequestError(code: 'bus.rejected', ...)` per the [SDK error model](../../packages/sdk/docs/Usage.md#error-handling).

  `busRequest` reads `e.response`, so **every reply handler must echo the request's `correlationId` and put its data under `response`** — a handler that doesn't echo the id hangs the caller until `bus.timeout`. The uniformity is exactly what lets the return type be derived from the registry instead of hand-annotated.

## Trace context: the `_trace` carrier

Distributed traces ride on the bus payload as a sibling of `correlationId`. The `_trace` field carries the W3C `traceparent` (and optional `tracestate`) so spans started by handlers become children of the originating span:

```ts
interface TraceCarrier {
  traceparent: string;     // W3C: '00-<traceId>-<spanId>-<flags>'
  tracestate?: string;     // vendor extensions
}
```

Two helpers in `@semiont/observability` manage the field:

- `injectTraceparent(payload)` — call before emitting; stamps the active span's traceparent onto `payload._trace`. No-op if no span is active.
- `extractTraceparent(payload)` — call on receipt; pulls and removes the field, returning the carrier so the handler can run under `withTraceparent(carrier, ...)`.

The HTTP gateway picks up the `traceparent` request header instead — the SSE event body doesn't have a header trailer, so HTTP-side delivery uses the request header and the bus payload is left alone. In-process transports (where there's no HTTP boundary) use the `_trace` carrier directly.

The field is **internal plumbing**: subscribers see it stripped before delivery, and most consumer code never needs to touch it. If you're writing a new transport, mirror the pattern — inject before emit, extract before subscriber dispatch.

For details on how `_trace` correlates with the grep-friendly `busLog` timeline and the OpenTelemetry span tree, see **[../system/administration/OBSERVABILITY.md](../system/administration/OBSERVABILITY.md)**.

## Resource scoping

A channel reaches clients in one of two **disjoint** delivery disciplines:

- **Global fan-out** — forwarded to every connected client, which filters by `correlationId` (correlation replies like `match:search-results`) or just reacts (KB-global events like `frame:entity-type-added`). This is the *bridged* set (see [Fan-in](#fan-in-sse-bridging)).
- **Resource-scoped** — delivered only to clients that have *joined* a resource's scope via `subscribeToResource(id)`. Publishers emit on a scoped bus (`eventBus.scope(resourceId)`); the HTTP transport carries the scope through SSE as `scope=<resourceId>&scoped=<channel>`. On the client, subscribing to a resource's `browse.*` live queries attaches a ref-counted scope that auto-detaches on the last unsubscribe (#847) — *freshness follows observation*.

The resource-scoped set is the **persisted domain events** (`mark:added`, `yield:created`, … on resource X → viewers of X), *minus any that are globally bridged*. The KB-global persisted events (`frame:entity-type-added`, `frame:tag-schema-added`) are bridged, so they're excluded from scoped delivery. The transport derives the set (`@semiont/http-transport`):

```ts
RESOURCE_SCOPED_CHANNELS = [
  ...PERSISTED_EVENT_TYPES.filter(t => !BRIDGED_CHANNELS.includes(t)),
  ...RESOURCE_BROADCAST_TYPES,
];
```

`RESOURCE_BROADCAST_TYPES` (in [bus-protocol.ts](../../packages/core/src/bus-protocol.ts)) is the extension point for *non-persisted* events that still want resource-scoped fan-out. It is **currently empty**: `job:complete` / `job:fail` were moved to global, `jobId`-keyed delivery (#847) — the dispatcher filters by `jobId`, viewers filter the same global stream by `resourceId`, so there's no scoped copy (and a client that is both no longer receives a duplicate).

**Bridged and resource-scoped must stay disjoint.** A channel delivered on *both* the global subscription and a scoped one arrives twice (with different SSE ids) → a duplicate on the client bus. The `filter(t => !BRIDGED_CHANNELS.includes(t))` above guarantees disjointness for the persisted-derived part; an invariant test (`BRIDGED_CHANNELS ∩ RESOURCE_SCOPED_CHANNELS === ∅`) backstops the unfiltered `RESOURCE_BROADCAST_TYPES` extension point.

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

`PERSISTED_EVENT_TYPES` in [persisted-events.ts](../../packages/core/src/persisted-events.ts) is the list of channels the event-sourcing layer treats as durable. Adding a new domain event means adding it to that list — a `StoredEvent`-typed entry in `EventMap` that isn't in `PERSISTED_EVENT_TYPES` will fail typecheck.

Commands, results, and UI signals are transient. They flow across the bus, drive handlers, and disappear. Only their downstream `-ed` events get recorded.

## Fan-in: SSE bridging

The SDK's `SemiontClient` owns a local `EventBus`; the HTTP transport bridges wire events into it. `BRIDGED_CHANNELS` in [bridged-channels.ts](../../packages/core/src/bridged-channels.ts) is the set the transport forwards — but it is no longer a hand-list. It is **derived**: every operation's reply channels (result + failure + optional progress) come from the `BUS_OPERATIONS` registry, plus a small hand-list `BRIDGED_BROADCASTS` of the non-request/reply minority (KB-global domain events like `frame:entity-type-added`, UI signals like `beckon:*`, and infra like `bus:resume-gap`). Deriving the reply set from the registry is what makes "a reply channel forgotten from the bridged set" — the recurring silent-timeout bug — unrepresentable.

```ts
// HttpTransport, on SSE receive:
for (const channel of BRIDGED_CHANNELS) {
  this.actor.on$(channel).subscribe((payload) => {
    for (const bus of this.bridges) {
      bus.get(channel).next(payload);
    }
  });
}
```

This is the *fan-in* set — what the transport pushes onto the client's bus. The set the client emits is open-ended and uses `transport.emit(channel, payload)` directly.

In-process transports do the same: `LocalTransport.bridgeInto(bus)` subscribes to the actor bus inside the make-meaning process and republishes on the caller's bus. Same shape, different wire.

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
| `EMIT` | `HttpTransport.emit()`, `LocalTransport.emit()`, backend `/bus/emit` route |
| `RECV` | HttpTransport SSE-side fan-in, `LocalTransport.bridgeInto` callback |
| `SSE` | Backend `writeBusEvent()` in `apps/backend/src/routes/bus.ts` |
| `PUT` | `HttpContentTransport.putBinary()` + matching backend route |
| `GET` | `HttpContentTransport.getBinary()` / `getBinaryStream()` + matching backend route |

The full capture API and per-test fixture are in **[../../tests/e2e/docs/bus-logging.md](../../tests/e2e/docs/bus-logging.md)**.

A clean round-trip across the wire shows a contiguous EMIT → EMIT → SSE → RECV pattern. Missing lines diagnose with surgical precision: no backend `EMIT` means the request never reached the server (auth, CORS, network); no backend `SSE` means the handler never produced a result; no frontend `RECV` means the SSE bytes never parsed.

## How the SDK shapes the protocol

The SDK doesn't *replace* the bus — it wraps the channel-call patterns so consumers don't write `correlationId` glue and `bus.stream(...).pipe(filter(...))` for every operation. Three layers of abstraction sit on top:

**1. `ITransport`** ([packages/core/src/transport.ts](../../packages/core/src/transport.ts)) — the contract every transport implements: `emit(channel, payload, scope?)`, `stream(channel)`, `subscribeToResource(id)`, `bridgeInto(bus)`. Transport-neutral. Both `HttpTransport` (HTTP+SSE) and `LocalTransport` (in-process actor bus) implement this same surface.

**2. `busRequest`** ([packages/core/src/bus-request.ts](../../packages/core/src/bus-request.ts)) — the request/response abstraction. Called with the **operation** (request channel) and a payload; it mints the `correlationId`, looks the result/failure channels up from `BUS_OPERATIONS`, applies a timeout, infers its return type from the result channel, and resolves to the response or rejects with a typed `BusRequestError`. Every namespace method that needs a round-trip is a thin call into this helper. (It lives in `@semiont/core`, so in-process workers use the same path.)

**3. Verb namespaces** (`semiont.mark.*`, `semiont.match.*`, `semiont.browse.*`, etc.) — the typed entry points. Each method picks the right channels for its operation, brands ID inputs, and returns the right shape (`Promise`, `StreamObservable`, `CacheObservable`). The channel choice is hidden behind the method name — `semiont.match.search(...)` knows it emits `match:search-requested` and resolves on `match:search-results` / `match:search-failed`.

Three legitimate paths to the bus, each suited to a distinct case:

- **Typed namespace method** (preferred) — `client.mark.annotation(...)`, `client.beckon.hover(...)`. Types catch mistakes; channel names and correlation IDs are internal. The right path whenever a namespace covers the operation.
- **`session.subscribe(channel, handler)`** — channel-by-name observation. The sanctioned escape hatch when the channel name is dynamic (`useEventSubscription` in React, an agent watching `mark:added` for collaborator activity) or no namespace exposes a typed listener for the channel you care about.
- **Direct `client.bus.get(channel)` / `client.transport.emit(channel, ...)`** — the lowest-level path, for workers and actors that *are* the handlers (Stower, Gatherer, Matcher, Smelter inside `@semiont/make-meaning` use this), for RxJS operator composition on a channel stream, or for prototyping new operations not yet wrapped by a namespace.

The three paths are documented end-to-end (with code shapes and call-site examples) in [`packages/sdk/docs/REACTIVE-MODEL.md`](../../packages/sdk/docs/REACTIVE-MODEL.md#three-paths-to-the-bus). The bus surface is *not* `@internal` — it's a real surface for advanced and worker use — but the typed namespaces are the canonical entry point for everything else. If you find yourself writing `transport.emit(channel, ...)` from application code, the right move is usually to reach for the namespace, or — if no namespace covers your case — to add one.

## Adding a new channel

The compile-time discipline is strict by design. A new channel requires changes in three places, all of which the typechecker enforces:

1. **`EventMap`** in [bus-protocol.ts](../../packages/core/src/bus-protocol.ts) — declare the channel name and payload type.
2. **`CHANNEL_SCHEMAS`** in the same file — map the channel to its OpenAPI schema name (or `null` for non-validated). The `satisfies Record<EventName, ...>` clause on this map fails to typecheck if you forget.
3. **`PERSISTED_EVENT_TYPES`** (only if it's a `StoredEvent` domain event) and, for SSE delivery, the routing: a request/reply operation is declared in **`BUS_OPERATIONS`** (which *derives* its reply channels into `BRIDGED_CHANNELS`); a non-request/reply broadcast that should reach every client is added to **`BRIDGED_BROADCASTS`**. You no longer hand-edit `BRIDGED_CHANNELS` for replies. Each list has its own completeness check, and an equality test pins the derived bridged set.

Then for the OpenAPI schema:

4. Add the schema file to `specs/src/components/schemas/`.
5. Reference it from the right path file under `specs/src/paths/` (if the channel has an HTTP entry point too).
6. Run `npm run generate:openapi --workspace=@semiont/core` to bundle and regenerate types.
7. Rebuild `@semiont/core`.

And for the SDK:

8. Add a namespace method that wraps `transport.emit(channel, ...)` or `busRequest(...)` for the new operation.
9. Update [packages/sdk/docs/Usage.md](../../packages/sdk/docs/Usage.md) under the right verb.

Skipping any step is caught at build time — `CHANNEL_SCHEMAS`'s `satisfies` clause and the `PERSISTED_EVENT_TYPES` exhaustiveness check make incomplete additions fail the typecheck loud and clear.

## See also

- **[CHANNELS.md](./CHANNELS.md)** — channel inventory: persisted events, ephemeral signals, correlation responses, resource broadcasts, bridged channels.
- **[TRANSPORT-CONTRACT.md](./TRANSPORT-CONTRACT.md)** — abstract `ITransport` behavioral guarantees every transport must honor.
- **[TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md)** — HTTP+SSE wire format; the `/bus/emit` and `/bus/subscribe` contract.
- **[`packages/core/src/bus-protocol.ts`](../../packages/core/src/bus-protocol.ts)** — the authoritative `EventMap` and `CHANNEL_SCHEMAS`.
- **[`packages/core/src/event-bus.ts`](../../packages/core/src/event-bus.ts)** — the in-process `EventBus` and `ScopedEventBus` implementation.
- **[../../tests/e2e/docs/bus-logging.md](../../tests/e2e/docs/bus-logging.md)** — the bus log format and capture API.
- **[../../packages/sdk/docs/Usage.md](../../packages/sdk/docs/Usage.md)** — the namespace tour with worked examples per verb.
- **[../system/administration/OBSERVABILITY.md](../system/administration/OBSERVABILITY.md)** — how `_trace` correlates with OpenTelemetry spans and the `busLog` grep timeline.
- **[flows/README.md](flows/README.md)** — the eight flows that organize the channel namespace.
