# Transport Contract

Behavioral guarantees that every `ITransport` implementation must honor.
Consumers writing portable code against `SemiontClient` rely on this
contract; consumers that know they're running over HTTP may
additionally depend on the HTTP-specific extensions documented at
[apps/backend/docs/TRANSPORT.md](../../../apps/backend/docs/TRANSPORT.md).

If the code deviates from what's written here, the code is wrong — or
this doc is wrong and needs updating, deliberately. No third option.

## Scope

`ITransport` is the wire-facing seam. Namespaces (browse, mark, bind,
gather, match, yield, beckon, job, auth, admin) consume it. The seam
hides whether a method goes over the network or runs in-process.

Current implementations:

- `HttpTransport` — HTTP + SSE to a remote Semiont backend. See
  [apps/backend/docs/TRANSPORT.md](../../../apps/backend/docs/TRANSPORT.md)
  for the HTTP-specific wire contract.
- `LocalTransport` *(Phase 2, not yet landed)* — direct in-process
  access to a `@semiont/make-meaning` runtime.

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

  // Typed wire methods: auth, admin, exchange, system
  authenticatePassword, authenticateGoogle, refreshAccessToken,
  logout, acceptTerms, getCurrentUser, generateMcpToken, getMediaToken,
  listUsers, getUserStats, updateUser, getOAuthConfig,
  backupKnowledgeBase, restoreKnowledgeBase,
  exportKnowledgeBase, importKnowledgeBase,
  healthCheck, getStatus
}
```

`IContentTransport` is a separate interface for binary I/O (`putBinary`,
`getBinary`, `getBinaryStream`). The split keeps backpressure and
streaming concerns away from the typed-channel surface.

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
- Ref-counted: calling twice with the same resourceId returns two
  disposers; the underlying scope is torn down only when the last one
  fires.
- **One distinct scope at a time.** Calling with a different
  resourceId while a subscription is live throws. Widening is deferred
  until a product requirement forces it.

### `bridgeInto(bus)`

**Ownership invariant: the client owns the bus.** `SemiontClient` constructs
its `EventBus` internally and hands a *reference* to the transport via
`bridgeInto`. The reference flows client → transport, never the other
way. Transports do not construct, replace, or substitute the bus; they
adapt to it.

- `HttpTransport.bridgeInto(bus)` stores the reference and pumps every
  channel it receives from SSE into that bus (and any subsequent
  per-resource scoped channels opened by `subscribeToResource`).
- `LocalTransport.bridgeInto(bus)` stores the reference and wires its
  in-process `KnowledgeSystem` actors to emit/listen on that bus, so
  client and KnowledgeSystem share one bus by construction.

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
- `LocalTransport` — the host process's service principal is the
  source; the transport injects its identity into every emitted
  payload.

Channels with this convention: `mark:archive`, `mark:unarchive`,
`mark:update-entity-types`, `mark:add-entity-type`, `bind:update-body`,
`job:create`, `mark:create-request`. The gateway's OpenAPI spec marks
`_userId` as *"Authenticated user's DID, injected by the /bus/emit
gateway. Clients do not set this."*

## `busRequest` — correlation-ID request/response

`busRequest(transport, emitChannel, payload, resultChannel,
failChannel, timeoutMs?)` is a shared helper built on the primitives:

- Generates a `correlationId`, adds it to the payload, emits, then
  observes the result and fail channels filtered on that
  correlationId.
- **30-second timeout** by default. Applies above the transport.
- **Return value tied to correlationId, not connection.** The caller
  gets exactly one resolution — the first matching result or fail
  event, or a timeout.

HTTP-specific: if the SSE connection drops after the emit and the
result arrives during the outage, it may be lost even on reconnect
(the result event is ephemeral, not persisted). `LocalTransport` is
synchronous — no outage, no loss.

## Connection state

Every transport exposes `state$: Observable<ConnectionState>` with the
same six-state union:

```
'initial' | 'connecting' | 'open' | 'reconnecting' | 'degraded' | 'closed'
```

`HttpTransport` drives all six (see
[apps/backend/docs/TRANSPORT.md](../../../apps/backend/docs/TRANSPORT.md)
for the state machine). `LocalTransport` emits `'connected'` once at
construction and never changes — consumers that show connecting /
reconnecting UI should treat `'connected'` as terminal.

## Event categorization

The bus protocol (not the transport) classifies channels into three
kinds. Every transport preserves the categorization:

- **Command events** — frontend → backend handler. Arrive un-scoped.
  Example: `mark:create-request`, `job:create`.
- **Correlation-ID responses** — handler → originating caller. Arrive
  un-scoped. Example: `mark:create-ok`, `job:status-result`.
- **Resource-bound broadcasts** — published on
  `eventBus.scope(resourceId)`. Delivered only to subscribers attached
  to that resource's scope via `subscribeToResource`. The set is named
  by `RESOURCE_BROADCAST_TYPES` in `@semiont/core`.

## Non-goals — what this doc is not

- Not an implementation guide. Each transport's source is authoritative
  for how it delivers these guarantees.
- Not a channel inventory. That lives in
  [apps/backend/docs/REAL-TIME.md](../../../apps/backend/docs/REAL-TIME.md).
- Not a bus-scope tutorial. See
  [apps/backend/docs/EVENT-BRIDGING.md](../../../apps/backend/docs/EVENT-BRIDGING.md).
