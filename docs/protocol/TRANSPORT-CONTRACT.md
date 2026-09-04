# Transport Contract

Behavioral guarantees that every `ITransport` implementation must honor.
Consumers writing portable code against `SemiontClient` rely on this
contract; consumers that know they're running over HTTP may
additionally depend on the HTTP-specific extensions documented at
[TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md).

If the code deviates from what's written here, the code is wrong — or
this doc is wrong and needs updating, deliberately. No third option.

## Scope

`ITransport` is the wire-facing seam. Namespaces (browse, mark, bind,
gather, match, yield, beckon, job, auth, admin) consume it. The seam
hides whether a method goes over the network or runs in-process.

The canonical wire implementation, `HttpTransport`, lives in
`@semiont/http-transport` and is documented in
[TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md).
Other implementations (e.g. in-process variants) live alongside the
runtime they wrap and are documented there.

## The surface

```ts
interface ITransport {
  // Bus primitives
  emit(channel, payload, resourceScope?): Promise<void>;
  on(channel, handler): () => void;
  stream(channel): Observable<payload>;

  // Lifecycle
  subscribeToResource(resourceId): () => void;
  bridgeInto(bus: EventBus): void;
  dispose(): void;
  readonly state$: Observable<ConnectionState>;
  readonly baseUrl: BaseUrl;

  // Typed wire methods: auth, admin, system
  authenticatePassword, authenticateGoogle, refreshAccessToken,
  logout, acceptTerms, getCurrentUser, getMediaToken,
  listUsers, getUserStats, updateUser, getOAuthConfig,
  healthCheck, getStatus
}
```

`IContentTransport` is a separate interface for resource content:
binary I/O (`putBinary`, `getBinary`, `getBinaryStream`) plus two
*derived* views of a resource, which are server-computed rather than
stored bytes.

`getResourceGraph` dereferences the resource's JSON-LD metadata graph —
the LD face an external linked-data client sees (the HTTP transport
fetches `/resources/:id/jsonld`; in-process transports assemble it from
their `KnowledgeSystem`).

`putAnchoredText` / `getAnchoredText` carry the resource's coordinate
map — its recovered text plus the geometry indexing it (see
[ANCHORING.md](../system/ANCHORING.md)). Whole-resource, like the graph:
a producer iterates page by page, but every consumer wants one map.
`getAnchoredText` answers `null` when none has been derived, which is
the common case and not an error. They are their own methods rather than
a `putBinary` of some derived media type — a coordinate map is not a
*representation* of the resource, and dressing it as one would make a
derived artifact indistinguishable from content a user uploaded.

The split keeps backpressure and streaming concerns away from the
typed-channel surface.

## Delivery semantics — what every transport must honor

### `emit(channel, payload, resourceScope?)`

- **At-most-once from the caller's perspective.** The returned Promise
  resolves when the transport has dispatched the payload. There is no
  acknowledgement that a subscriber processed it.
- **No ordering across emits from the same caller.** Two `emit()` calls
  made back-to-back may reach handlers in either order. Handlers that
  require ordering must encode it in the payload.
- **Synchronous dispatch, asynchronous processing.** By the time the
  Promise resolves, the transport has published the event; what
  handlers do with it is their own clock.
- **`resourceScope`, when set, targets resource-scoped broadcasts.**
  Only subscribers attached to that resource's scope receive the event.
  Ordinary commands omit it.

### `stream(channel)` / `on(channel, handler)`

- **At-most-once delivery** per subscriber. Subscribers receive events
  published while they were subscribed. Events published before
  `subscribe` are not delivered.
- **Per-channel ordering within a single subscriber.** Events on a
  single channel are delivered in the order they were published.
  Events across channels have no ordering guarantee.
- **No deduplication.** If the same event is published twice, each
  subscriber sees it twice.

### `subscribeToResource(resourceId)`

- Attaches the transport to a single resource's scoped broadcast
  stream. The returned disposer detaches when called.
- Ref-counted **per resource**: calling twice with the same resourceId
  returns two disposers; that resource's scope is torn down only when
  the last one fires.
- **Distinct resources COMPOSE.** One transport holds any number of
  resource scopes concurrently, each with an independent ref-count and
  release — N mounted viewers on N resources are all live at once. (The
  historical one-scope-at-a-time floor, and its different-resource
  throw, were removed 2026-07-29.)
- **SDK-internal, not consumer-facing.** Application code does not call
  this — the SDK's resource-scoped `browse.*` live queries drive it:
  subscribing acquires the scope, the last unsubscribe releases it
  (freshness follows observation; #847).

### `bridgeInto(bus)`

**Ownership invariant: the client owns the bus.** `SemiontClient` constructs
its `EventBus` internally and hands a *reference* to the transport via
`bridgeInto`. The reference flows client → transport, never the other
way. Transports do not construct, replace, or substitute the bus; they
adapt to it.

`HttpTransport.bridgeInto(bus)` stores the reference and pumps every
channel it receives from SSE into that bus (and any subsequent
per-resource scoped channels opened by `subscribeToResource`).
In-process transports adapt the same hook to whatever local source they
wrap.

Constructors of concrete transports never accept a bus. The bus arrives
*only* through `bridgeInto`, which is called once by `SemiontClient` at
construction time. `SemiontClient`'s constructor signature is
`(transport, content)` — callers do not pass a bus in. If they need to
read it, they go through `client.bus`.

## User identity — `_userId` injection

**Invariant:** every bus command that requires an authenticated user
reads the user's DID from a gateway-injected `_userId` field on the
payload. Clients do not set it; handlers cannot trust a client-supplied
`userId` field.

**Mechanism is transport-specific:**

- `HttpTransport` — the `/bus/emit` gateway reads the JWT subject and
  injects it as `_userId` before publishing on the bus.
- In-process transports — the host process's service principal is the
  source; the transport injects its identity into every emitted
  payload.

Channels with this convention: `mark:archive`, `mark:unarchive`,
`mark:update-entity-types`, `frame:add-entity-type`, `bind:update-body`,
`job:create`, `mark:create-request`. The gateway's OpenAPI spec marks
`_userId` as *"Authenticated user's DID, injected by the /bus/emit
gateway. Clients do not set this."*

## `busRequest` — correlation-ID request/response

`busRequest(bus, operation, payload, timeoutMs?)` is a shared helper
(in `@semiont/core`) built on the primitives:

- Called with the **operation** — the request channel — and a payload.
  It looks the result and failure channels up from the `BUS_OPERATIONS`
  registry, generates a `correlationId`, adds it to the payload, emits,
  and observes those reply channels filtered on that correlationId.
- **Return type inferred** from the operation's result channel — callers
  pass neither the reply channels nor a `<TResult>` annotation. Replies
  follow the standard shape (`{ correlationId, response: T }` /
  `{ correlationId }` / `{ correlationId } & CommandError`); `busRequest`
  resolves `response` or rejects with a typed error.
- **30-second timeout** by default. Applies above the transport.
- **Return value tied to correlationId, not connection.** The caller
  gets exactly one resolution — the first matching result or fail
  event, or a timeout.
- **Reply tracking.** `busRequest` registers its correlationId with the
  transport's optional `trackReply` BEFORE emitting and releases it on
  every settle path. Wire transports carry the tracked set on each
  subscribe (`pendingReplies`) so a reply published during an outage is
  replayed from the server's bounded retention buffer on reconnect.
  In-process transports omit the surface — publishing on the same
  in-memory bus they read from, they have no outage and no loss.

## Delivery guarantees — two tiers, deliberately

The transport delivers two kinds of one-way traffic with DIFFERENT
durability, and the asymmetry is the design, not a gap:

- **Persisted domain events** (the event-store-backed set): **durable,
  effectively exactly-once** from the client's perspective. Each scope
  carries a resumption watermark on the subscribe body; the server
  replays the gap from the event store; replay/live overlap dedups by
  stable id; `bus:resume-gap` is the explicit signal when replay cannot
  cover. Survives client reloads and arbitrary offline windows (bounded
  only by event-store retention).
- **Correlated replies** (one-shot `busRequest` results): **at-most-once
  publication with bounded retained redelivery** — effectively
  exactly-once for the original requester *within its own deadline
  envelope* (retention TTL is 2× the default `busRequest` timeout;
  deterministic `e-<channel>:<cid>` ids dedup replay against any live
  copy). NOT durable: retention is in-memory, so a gateway restart —
  and, in a future multi-instance deployment, a reconnect landing on a
  different instance — loses it. Those residuals degrade to exactly the
  pre-retention outcome (the caller's timeout), never worse; the
  multi-instance case is the named tripwire that must reopen this
  design (sticky routing or a shared store) before replicas ship.

Why the tiers differ: a domain event matters forever — every future
reader needs it. A reply matters only to one caller, only until that
caller's deadline; durability past the deadline buys nothing. Consumers
keep their defense-in-depth (the cache's bounded retry and terminal
`failed` state), but under this contract those paths should fire
approximately never — a `bus.timeout` that does fire is a real signal
that the gateway is down or slow, not transport weather.

## Connection state

Every transport exposes `state$: Observable<ConnectionState>` with the
same seven-state union:

```
'initial' | 'connecting' | 'open' | 'reconnecting' | 'degraded'
          | 'unauthenticated' | 'closed'
```

`unauthenticated` means the transport is deliberately NOT attempting:
its credential is absent, or was refused (401) and only a different one
is worth trying. No network activity happens in this state, and the
transport leaves it on its own when a usable credential appears (a
re-login, a session refresh). The refusal that caused it is on the
transport's error stream — the state answers "can the bus deliver?",
the error stream answers "why not" (SSE-AUTH-RESILIENCE D3/D6a).

`HttpTransport` drives all seven (see
[TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md)
for the state machine). An in-process transport is `'open'` from
construction and never changes — consumers that show connecting /
reconnecting UI should treat the open state as terminal.

## Event categorization

The bus protocol (not the transport) classifies channels into three
kinds. Every transport preserves the categorization:

- **Command events** — Browser → gateway handler. Arrive un-scoped.
  Example: `mark:create-request`, `job:create`.
- **Correlation-ID responses** — handler → originating caller. Arrive
  un-scoped. Example: `mark:create-ok`, `job:status-result`.
- **Resource-bound broadcasts** — published on
  `eventBus.scope(resourceId)`. Delivered only to subscribers attached
  to that resource's scope via `subscribeToResource`. The scoped set is
  *derived* — the persisted domain events that aren't globally bridged,
  plus the (currently empty) `RESOURCE_BROADCAST_TYPES` extension point
  in `@semiont/core`. It is **disjoint** from the bridged (global) set
  by construction and by invariant test; a channel in both would be
  delivered twice. See [TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md).

## Non-goals — what this doc is not

- Not an implementation guide. Each transport's source is authoritative
  for how it delivers these guarantees.
- Not a channel inventory. That lives in
  [CHANNELS.md](./CHANNELS.md).
- Not a bus-scope tutorial. See [EVENT-BUS.md § Resource scoping](./EVENT-BUS.md#resource-scoping).
