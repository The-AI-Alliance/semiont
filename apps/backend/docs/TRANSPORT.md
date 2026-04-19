# Bus Gateway Transport Contract

**Purpose**: define the contract the bus gateway actually honors
between the browser (or any headless client) and the backend. If the
code deviates from what's written here, the code is wrong — or this
doc is wrong and needs updating, deliberately. No third option.

The two existing docs next door describe different things:

- [STREAMS.md](./STREAMS.md) — the architecture (what routes exist, what
  handlers subscribe to what).
- [REAL-TIME.md](./REAL-TIME.md) — the event inventory (which channels
  carry what kind of payload, scoped vs. global).

This doc is the formal **contract** — delivery guarantees, ordering,
lifecycle, failure modes. It's what a consumer should be able to rely
on without reading every line of `@semiont/api-client`.

## Non-goals

- **Not an implementation guide.** `STREAMS.md` does that.
- **Not a scope tutorial.** `SIMPLE-BUS.md` does that.
- **Not a wishlist.** This doc describes what *is*, not what should
  be. Known gaps are called out in a dedicated section at the bottom
  so they can't be confused with guarantees.

## The two primitives

```
Browser / headless client                         Backend
  │                                                  │
  │    POST /bus/emit                                │
  │    { channel, payload, scope? }  →  202          │
  │ ─────────────────────────────────────►           │
  │                                                  │
  │    GET  /bus/subscribe?channel=X&scope=&scoped=  │
  │ ◄── event-stream ──────────────────────────────  │
  │                                                  │
```

- `POST /bus/emit` — fire-and-forget. Body is a single
  `{channel, payload, scope?}`. 202 on accepted; 400 on validation
  failure or unknown channel; 401 on auth failure.

- `GET /bus/subscribe` — long-lived SSE. Query string selects global
  channels (`channel=X` may repeat) and a single resource-scoped
  channel group (`scope=rId&scoped=Y` with `scoped` repeatable).

Every event carries an `event:` line of `bus-event` and a `data:` line
of `{channel, payload, scope?}`.

No other transport is used for bus traffic. Regular HTTP is for auth,
health, and binary resources.

## Authentication and authorization

Both endpoints require a valid JWT (`Authorization: Bearer …`).

- 401: token missing, malformed, expired, or signed with a key the
  backend doesn't recognize (e.g. the backend was restarted with a
  different secret, making earlier-issued tokens invalid).
- 403: currently not used. All authenticated users see all channels.
  That's a known gap — see "Known gaps" below.

The gateway injects `_userId` (the token subject's DID) into every
emitted payload. Handlers read it via `command._userId`; it's the
only identity signal they can trust.

## Delivery semantics

### `POST /bus/emit`

- **At-most-once**, from the client's perspective. The client emits;
  the server accepts with 202 or rejects with 4xx. There's no
  acknowledgement that a subscriber received the event, only that the
  backend dispatched it onto the `EventBus`.
- **No ordering across emits** from the same client. Two emits made
  back-to-back may hit the handler in either order, because they're
  two independent HTTP requests. Handlers that require ordering must
  encode it in the payload (e.g. via `sequence` or `previous`).
- **Synchronous dispatch, asynchronous processing.** By the time the
  client receives 202, the `EventBus.next()` has fired and any
  registered handler has been notified. What the handler *does* with
  the event is asynchronous and out of the emit's control.

### `GET /bus/subscribe`

- **At-most-once delivery with resumption for persisted events.** An
  event is delivered to every SSE connection subscribed to its
  channel at the moment the event is published. Connections that
  weren't live at that moment don't see the live delivery, but
  **persisted events can be replayed** — see "Event id and
  resumption" below.
- **Per-channel ordering within a single connection.** Events on a
  single channel are delivered in the order they were published on
  that bus. Events across channels have no ordering guarantee.
- **No deduplication.** If the same event is published twice (e.g. by
  two handlers), a subscriber sees it twice.
- **Persisted domain events are special**. These events go through
  `EventStore.appendEvent`, which publishes on BOTH the global bus AND
  the resource-scoped bus. A client subscribed to a resource scope
  receives each persisted event once via the scoped delivery; a
  client subscribed globally receives each persisted event once via
  the global delivery; a client subscribed both ways receives it
  twice.

#### Event id and resumption

Every event on the SSE stream carries an `id:` field of one of two
shapes:

| Shape | Meaning | Resumable |
|---|---|---|
| `p-<scope>-<seq>` | Persisted event, scoped. `<scope>` is the resource id, `<seq>` is `event.metadata.sequenceNumber`. | **Yes.** |
| `e-<connectionId>-<counter>` | Ephemeral event or persisted event delivered on an unscoped channel. The id is unique per connection but carries no replay meaning. | No. |

Clients SHOULD track the last `id:` seen and send it as the
`Last-Event-ID` request header on every reconnect. When the server
receives `Last-Event-ID: p-<scope>-<seq>`:

1. If the subscription's `scope=` query param matches `<scope>`, the
   server queries the event store for persisted events in that scope
   with `sequenceNumber > <seq>`, filtered to the subscribed
   `scoped=` channels, and replays them on the stream before the live
   tail starts.
2. If replay can't cover the gap (retention window exceeded, scope
   mismatch, unparseable id, query error), the server emits a
   synthetic `bus:resume-gap` event describing the reason and
   optional `scope`. The client should treat this as a signal to
   fall back to blanket invalidation for the affected scope.

Ephemeral ids sent back as `Last-Event-ID` are accepted without
replay and without a gap event — they simply establish "no
resumption context," as if the client had sent no header.

Clients that never send `Last-Event-ID` get live-only behavior, same
as before resumption was introduced.

### Combined request-response (`busRequest`)

The `busRequest` helper ([packages/api-client/src/bus-request.ts](../../../packages/api-client/src/bus-request.ts))
layers a request-response pattern on top of the two primitives:

- Client mints a fresh `correlationId`.
- Subscribes on the actor to `resultChannel` and `failureChannel`,
  filtered by that correlationId.
- Emits the request payload via `actor.emit()`.
- First matching response resolves; first matching failure rejects.
- Default timeout: 30 s. On timeout, the subscription is torn down;
  any late-arriving response is dropped.

The guarantee is **at-most-once response delivery**. Specifically:

- If the SSE connection is live when the backend publishes the
  response, the client receives it.
- **If the SSE connection was torn down and replaced during the
  request window, the response was published to a dead subscriber
  and is lost.** The client sees only the 30s timeout. There is no
  retry.

This last bullet is the load-bearing quirk. A consumer that cares
about eventual correctness must either (a) accept the timeout and
retry the whole request, or (b) layer a cache that can
refetch-on-reconnect (which is what `BrowseNamespace` does).

## Connection lifecycle

Exposed to consumers as `actor.state$: Observable<ConnectionState>`,
a six-state machine:

| State | Meaning |
|---|---|
| `initial` | Before `start()` has been called. |
| `connecting` | `fetch()` is in flight; no bytes received yet. |
| `open` | SSE stream is live; at least one frame received. |
| `reconnecting` | Was open or connecting; now retrying. May be transient (mount churn, channel-set change) or sustained (network loss). |
| `degraded` | Has been in `reconnecting` for longer than `DEGRADED_THRESHOLD_MS` (3 s). UI banner threshold — distinguishes brief churn from real disconnection. |
| `closed` | `stop()` or `dispose()` was called. Terminal. |

Transitions are enforced by an internal helper that throws on
invalid moves, so a buggy reconnect path surfaces in tests rather
than stranding the observable at a lying value.

Allowed transitions:

```
initial      → connecting | closed
connecting   → open | reconnecting | closed
open         → reconnecting | closed
reconnecting → connecting | degraded | closed
degraded     → connecting | closed
closed       → (terminal)
```

Gap detection is handled by the resumption protocol (see "Event id
and resumption" above), not by the consumer interpreting state edges.

### Reconnect discipline (client side)

The client-side `ActorVM` handles three reconnect triggers:

1. **Server/network disconnect.** The SSE read loop exits; state
   transitions to `reconnecting`; `connect()` is retried after
   `reconnectMs` (default 5 s). If the retry takes longer than
   `DEGRADED_THRESHOLD_MS`, state enters `degraded`.
2. **Channel-set change** (`addChannels` / `removeChannels`). The
   current SSE is aborted and a new one is opened with the updated
   query string. Reconnects are **debounced 100 ms** so React Strict
   Mode's mount → cleanup → mount sequence collapses into one
   reconnect. State cycles `open → reconnecting → connecting →
   open` without reaching `degraded` (the round-trip is sub-second).
3. **Explicit `stop()` / `dispose()`.** State transitions to
   `closed`; the observable completes. No retry.

On every reconnect, the client sends the last seen `id:` as the
`Last-Event-ID` request header. For a clean reconnect (no persisted
events missed), the server replays nothing and live delivery
resumes. Consumers should NOT revalidate caches on the
`reconnecting → open` transition — that work is driven by the
`bus:resume-gap` event, which the server emits only when it
genuinely can't cover the gap.

**All in-flight fetches are aborted when a new connect starts.** The
client tracks SSE fetch controllers as a set; every previous one is
aborted before the new one begins. This prevents orphaned streams
from accumulating when rapid channel-set changes race each other.

## Event categorization and scope

Every channel falls into exactly one of three categories. The
category determines scoping semantics and delivery path.

| Category | Scope on wire | Receivers |
|---|---|---|
| Command (one handler) | None | The single global handler. |
| Correlation-ID response | None | The caller, filtering by correlationId. |
| Resource-bound broadcast | `resourceId` | Every SSE connection subscribed to that scope. |

System-wide broadcasts (`beckon:focus`, `mark:entity-type-added`,
etc.) are a special case of correlation-ID responses in terms of
scoping: they go global, but they're received by every connected
client, not filtered.

This table is the single source of scope truth. Any new channel must
fit in one of the three rows. If it doesn't, the channel is wrong.

See [STREAMS.md § "When to scope"](./STREAMS.md) for the rule's
statement; this doc just references it as the settled contract.

## Schema validation

Every inbound event at `POST /bus/emit` is validated against the
schema declared in `CHANNEL_SCHEMAS` ([packages/core/src/bus-protocol.ts](../../../packages/core/src/bus-protocol.ts)).

- Channels with a named schema: payload must match, or 400.
- Channels with a `null` schema entry: no validation (payload is a
  compound / branded type not expressible as a single OpenAPI schema).
- Channels not present in `CHANNEL_SCHEMAS`: 400 with "Unknown
  channel". The map's `satisfies Record<EventName, ...>` forces it to
  cover every `EventName` — a new channel added to `EventMap` that
  isn't added here is a build error.

Outbound events on `/bus/subscribe` are not validated; they're
produced by backend code that's already type-checked. If a handler
publishes a malformed payload, the client will fail to parse the
JSON frame.

## Contract summary for consumers

A consumer that wants correctness must assume:

- Every `/bus/emit` either succeeds (202) or fails (4xx). There's no
  third outcome.
- Every event on the SSE stream is live unless delivered as part of
  a replay response to `Last-Event-ID`. Ephemeral events (command
  responses, progress) are never replayed; persisted domain events
  are replayed only when the client sent a `p-*` resumption id on
  reconnect.
- A bare reconnect (no gap) requires no cache action from the
  consumer. A gap the server couldn't cover arrives as a
  `bus:resume-gap` event; on that event, the consumer must revalidate
  state for the affected scope.
- `busRequest` has a 30 s timeout and no retry. Callers that require
  retry must wrap.
- CorrelationIds are the only way to match a request to its response.
  They must be UUIDs or equivalently-unique. The backend does not
  deduplicate them.

## Known gaps (deliberately surfaced)

These are open limitations of the contract above. They're listed so
future work can reference them specifically instead of rediscovering
them.

### Cache layer reimplements SWR / React Query

`packages/api-client/src/namespaces/browse.ts` implements
stale-while-revalidate, in-flight dedup, and event-driven
invalidation by hand. See
[`packages/api-client/docs/CACHE-SEMANTICS.md`](../../../packages/api-client/docs/CACHE-SEMANTICS.md)
for the full behavioral spec. The constraint we're honoring is
framework-agnosticism — the same client is used by React, the CLI,
MCP server, and workers.

Consequence: every race in the cache (stuck guard, invalidate-loop,
concurrent refetches) is a bug that published SWR implementations
have documented fixes for, which we rediscover by bisection. The
current state: SWR semantics are landed everywhere with a contract
test suite, but the cache is still a collection of ad-hoc maps
rather than a reusable primitive.

### Scope is per-connection, not per-channel

The SSE URL format takes one `scope=X` and many `scoped=Y` channel
names within that scope. A single connection can subscribe to many
channels under one resource scope, but cannot mix two resource
scopes.

This is a floor that matches current UX (one resource viewer at a
time). Triggers for widening: a UI feature requiring two resource
viewers simultaneously, a headless client watching many resources
in parallel, or legitimate different-scope concurrent subscribe
calls firing in production.

### No channel-level authorization

Any authenticated user who subscribes to a channel receives
everything on that channel. Resources don't have per-user ACLs in
the transport layer. Handlers may enforce authorization in the
handler body (e.g. by checking `_userId`), but `/bus/subscribe`
itself does not filter. This is a genuine limitation for any
multi-tenant deployment.

## Rules of thumb for consumer code

### Effects that subscribe MUST be idempotent across cleanup cycles

React Strict Mode double-invokes effects (mount → cleanup → mount)
to shake out cleanup bugs. Any code that interacts with the bus —
calling `subscribeToResource`, registering an event handler, wiring
a ViewModel — must survive this. Concretely:

- `subscribeToResource(X)` called twice in a row with the same `X`
  must be a no-op on the second call (ref-counted today; first call
  adds, second increments a count, both unsubscribes required before
  the scope is actually removed).
- A ViewModel whose factory captures props must be keyed on those
  props (`<Inner key={rId} />`) so the factory reruns when they
  change. `useViewModel`'s factory does NOT re-run across renders
  by design — see the tests in
  `packages/react-ui/src/hooks/__tests__/useViewModel.test.tsx` for
  the locked-in semantic.

### Request-response callers must handle response-lost

Because responses are at-most-once and a reconnect during the
request window drops them, any caller that must eventually complete
needs one of:

- A cache-layer refetch on reconnect (`BrowseNamespace`'s gap
  detection is the reference example).
- An explicit retry on timeout.
- Acceptance that the operation is fire-and-forget and re-request on
  demand is sufficient.

### New channels must be classified at definition time

A new channel is either a command, a correlation-ID response, or a
resource-bound broadcast. Pick one and commit. The three-row table
above is the decision tree.

## Where the code implementing this contract lives

- `apps/backend/src/routes/bus.ts` — the `/bus/emit` and
  `/bus/subscribe` routes.
- `packages/core/src/bus-protocol.ts` — `EventMap`, `CHANNEL_SCHEMAS`,
  `EmittableChannel`, `RESOURCE_BROADCAST_TYPES`.
- `packages/api-client/src/view-models/domain/actor-vm.ts` — the
  client-side SSE reader, reconnect logic, channel-set management.
- `packages/api-client/src/bus-request.ts` — correlation-ID matcher.
- `packages/event-sourcing/src/event-store.ts` — persisted-event
  dual-publish (global + scoped).

## Revision log

A deliberate choice to keep this as a separate section so changes to
the contract are visible.

- **2026-04-19** — initial draft, reflecting the contract after the
  SIMPLE-BUS work plus the reconnect debounce fix.
- **2026-04-19** — `Last-Event-ID` resumption landed. Persisted
  events now carry `p-<scope>-<seq>` ids; scoped-subscribe requests
  with `Last-Event-ID` trigger event-store replay. `bus:resume-gap`
  is the server's signal that it couldn't cover the gap. Consumer
  contract changes: bare reconnects no longer require cache
  invalidation. Also: actor-vm now tracks all in-flight fetch
  controllers and aborts every previous one on new connect, closing
  an orphan-stream leak.
- **2026-04-19** — connection-state machine landed.
  `actor.connected$: Observable<boolean>` replaced with
  `actor.state$: Observable<ConnectionState>` (initial / connecting
  / open / reconnecting / degraded / closed). Transitions are
  enforced; `degraded` fires after 3 s in `reconnecting`, giving
  UI a non-timing-heuristic signal to differentiate mount churn
  from sustained disconnection.
