# HTTP Bus Gateway Contract

**Purpose**: the HTTP-specific contract for the bus gateway between the
browser (or any headless client) and the Semiont backend. If the code
deviates from what's written here, the code is wrong — or this doc is
wrong and needs updating, deliberately. No third option.

Transport-agnostic guarantees (at-most-once emit, per-channel ordering,
`busRequest` semantics, `_userId` injection invariant) live in the
shared contract at
[`packages/core/docs/TRANSPORT-CONTRACT.md`](../../../packages/core/docs/TRANSPORT-CONTRACT.md).
This doc covers only what's specific to the HTTP + SSE wire.

Neighboring docs:

- [STREAMS.md](./STREAMS.md) — the architecture (what routes exist,
  what handlers subscribe to what).
- [REAL-TIME.md](./REAL-TIME.md) — the event inventory (which channels
  carry what kind of payload, scoped vs. global).
- [EVENT-BRIDGING.md](./EVENT-BRIDGING.md) — the scope tutorial.

## Non-goals

- **Not an implementation guide.** `STREAMS.md` does that.
- **Not the shared transport contract.** See
  [`packages/core/docs/TRANSPORT-CONTRACT.md`](../../../packages/core/docs/TRANSPORT-CONTRACT.md)
  for guarantees that every `ITransport` honors.
- **Not a wishlist.** This doc describes what *is*, not what should be.
  Known gaps are called out in a dedicated section so they can't be
  confused with guarantees.

## The two wire primitives

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
emitted payload. Handlers read it via `command._userId`; it's the only
identity signal they can trust. This is an `ITransport` invariant —
the shared contract names the guarantee; this gateway is the mechanism.

## HTTP-specific delivery semantics

The shared contract (at-most-once emit, per-channel ordering, no
deduplication) applies unchanged. HTTP adds:

### `POST /bus/emit`

- Two emits from the same client are **two independent HTTP requests**.
  They may reach the handler in either order. Ordering has to be in
  the payload.
- **Schema validation**. Every inbound payload is validated against
  `CHANNEL_SCHEMAS` ([packages/core/src/bus-protocol.ts](../../../packages/core/src/bus-protocol.ts));
  this is an HTTP-layer guard because the wire is untyped JSON.
  - Channels with a named schema: payload must match, or 400.
  - Channels with a `null` schema entry: no validation (compound /
    branded type not expressible as a single OpenAPI schema).
  - Channels not present in `CHANNEL_SCHEMAS`: 400 with "Unknown
    channel". The map's `satisfies Record<EventName, ...>` forces
    coverage of every `EventName` — a new channel added to `EventMap`
    but not `CHANNEL_SCHEMAS` is a build error.

### `GET /bus/subscribe`

- **At-most-once delivery with resumption for persisted events.** A
  connection that wasn't live at publication time doesn't see the live
  delivery, but persisted events can be replayed on reconnect. See
  "Event id and resumption" below.
- **Persisted domain events dual-publish.** `EventStore.appendEvent`
  publishes on BOTH the global bus AND the resource-scoped bus. A
  client subscribed to a resource scope receives each persisted event
  once via the scoped delivery; a client subscribed globally receives
  it once via the global delivery; a client subscribed both ways
  receives it twice. (No deduplication — the shared contract already
  prohibits it.)

#### Event id and resumption

Every event on the SSE stream carries an `id:` field of one of two
shapes:

| Shape | Meaning | Resumable |
|---|---|---|
| `p-<scope>-<seq>` | Persisted event, scoped. `<scope>` is the resource id, `<seq>` is `event.metadata.sequenceNumber`. | **Yes.** |
| `e-<connectionId>-<counter>` | Ephemeral event or persisted event delivered on an unscoped channel. Unique per connection; no replay meaning. | No. |

Clients SHOULD track the last `id:` seen and send it as the
`Last-Event-ID` request header on every reconnect. When the server
receives `Last-Event-ID: p-<scope>-<seq>`:

1. If the subscription's `scope=` query param matches `<scope>`, the
   server queries the event store for persisted events in that scope
   with `sequenceNumber > <seq>`, filtered to the subscribed `scoped=`
   channels, and replays them before the live tail starts.
2. If replay can't cover the gap (retention window exceeded, scope
   mismatch, unparseable id, query error), the server emits a
   synthetic `bus:resume-gap` event describing the reason and optional
   `scope`. The client should treat this as a signal to fall back to
   blanket invalidation for the affected scope.

Ephemeral ids sent back as `Last-Event-ID` are accepted without replay
and without a gap event — they establish "no resumption context," as
if no header were sent.

Clients that never send `Last-Event-ID` get live-only behavior.

### HTTP-specific quirk: response-lost during reconnect

The shared contract defines `busRequest` as at-most-once with a 30s
timeout. Over HTTP, **if the SSE connection was torn down and replaced
during the request window, the response was published to a dead
subscriber and is lost.** The client sees only the 30s timeout. There
is no retry.

This is the load-bearing HTTP quirk. Consumers that must eventually
complete must either (a) accept the timeout and retry, or (b) layer a
cache that refetches on reconnect (`BrowseNamespace` does the latter).

`LocalTransport` doesn't have this failure mode — in-process
subscribers never disconnect during a call.

## Connection lifecycle (HTTP only)

The shared contract exposes `state$: Observable<ConnectionState>` with
six states. HTTP drives all six; local transports sit at `'connected'`
from construction. The HTTP state machine:

| State | Meaning |
|---|---|
| `initial` | Before `start()` has been called. |
| `connecting` | `fetch()` is in flight; no bytes received yet. |
| `open` | SSE stream is live; at least one frame received. |
| `reconnecting` | Was open or connecting; now retrying. May be transient (mount churn, channel-set change) or sustained (network loss). |
| `degraded` | Has been in `reconnecting` for longer than `DEGRADED_THRESHOLD_MS` (3 s). UI banner threshold — distinguishes brief churn from real disconnection. |
| `closed` | `stop()` or `dispose()` was called. Terminal. |

Transitions are enforced by an internal helper that throws on invalid
moves, so a buggy reconnect path surfaces in tests rather than
stranding the observable at a lying value.

Allowed transitions:

```
initial      → connecting | closed
connecting   → open | reconnecting | closed
open         → reconnecting | closed
reconnecting → connecting | degraded | closed
degraded     → connecting | closed
closed       → (terminal)
```

Gap detection is handled by the resumption protocol (see "Event id and
resumption"), not by consumers interpreting state edges.

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
   reconnect. State cycles `open → reconnecting → connecting → open`
   without reaching `degraded` (the round-trip is sub-second).
3. **Explicit `stop()` / `dispose()`.** State transitions to `closed`;
   the observable completes. No retry.

On every reconnect, the client sends the last seen `id:` as the
`Last-Event-ID` request header. For a clean reconnect (no persisted
events missed), the server replays nothing and live delivery resumes.
Consumers should NOT revalidate caches on the `reconnecting → open`
transition — that work is driven by `bus:resume-gap`, which the server
emits only when it genuinely can't cover the gap.

**All in-flight fetches are aborted when a new connect starts.** The
client tracks SSE fetch controllers as a set; every previous one is
aborted before the new one begins. Prevents orphaned streams from
accumulating when rapid channel-set changes race each other.

## Wire framing and client parser obligations

The SSE stream is plain `text/event-stream`. Each event is written as:

```
event: bus-event
id: <ephemeral or persisted id>
data: <JSON-stringified {channel, payload, scope?}>
<blank line>
```

The backend writes each event through Hono's `streamSSE` with no
compression and no chunked-JSON framing — `data:` is always exactly
one line, followed by one terminating blank line.

**Client parsers must hold event-assembly state across `reader.read()`
boundaries.** A single SSE event can exceed the first TCP segment (a
full `browse:resource-result` carries the resource plus annotations,
easily past the first-chunk size). The reference parser in
`packages/api-client/src/view-models/domain/actor-vm.ts` keeps
`currentEvent` / `currentData` / `currentId` outside its read loop;
any replacement must do the same, or any event that chunks across
reads is silently dropped — the `data:` header lands in one chunk and
the blank-line terminator in the next, and resetting state per-chunk
breaks dispatch.

This constraint is tested by
`packages/api-client/src/view-models/domain/__tests__/actor-vm.test.ts`
→ "reassembles an event whose bytes span multiple reader.read()
chunks". If you swap the parser, port the test.

## Event categorization and scope

Every channel falls into exactly one of three categories. The category
determines scoping semantics and delivery path.

| Category | Scope on wire | Receivers |
|---|---|---|
| Command (one handler) | None | The single global handler. |
| Correlation-ID response | None | The caller, filtering by correlationId. |
| Resource-bound broadcast | `resourceId` | Every SSE connection subscribed to that scope. |

System-wide broadcasts (`beckon:focus`, `mark:entity-type-added`, etc.)
are a special case of correlation-ID responses in terms of scoping:
they go global, but they're received by every connected client, not
filtered.

This table is the single source of scope truth. Any new channel must
fit in one of the three rows. See [STREAMS.md § "When to scope"](./STREAMS.md).

## HTTP-specific contract summary

A consumer that wants correctness over HTTP must assume:

- Every `/bus/emit` either succeeds (202) or fails (4xx). No third
  outcome.
- Every SSE event is live unless delivered as part of a replay
  response to `Last-Event-ID`. Ephemeral events (command responses,
  progress) are never replayed; persisted domain events are replayed
  only when the client sent a `p-*` resumption id on reconnect.
- A bare reconnect (no gap) requires no cache action. A gap the server
  couldn't cover arrives as a `bus:resume-gap` event; on that event,
  the consumer must revalidate state for the affected scope.
- `busRequest` has a 30s timeout and no retry. HTTP adds: a reconnect
  during the request window drops the response. Callers that must
  eventually complete need (a) a cache-layer refetch, (b) an explicit
  retry on timeout, or (c) acceptance that the operation is
  fire-and-forget.
- CorrelationIds are the only way to match a request to its response.
  They must be UUIDs or equivalently-unique. The backend does not
  deduplicate them.

## Known gaps (deliberately surfaced)

Open limitations of the HTTP contract. Listed so future work can
reference them specifically instead of rediscovering them.

### Cache layer reimplements SWR / React Query

`packages/api-client/src/namespaces/browse.ts` implements
stale-while-revalidate, in-flight dedup, and event-driven invalidation
by hand. See
[`packages/sdk/docs/CACHE-SEMANTICS.md`](../../../packages/sdk/docs/CACHE-SEMANTICS.md).
The constraint we're honoring is framework-agnosticism — the same
client is used by React, the CLI, MCP server, and workers.

Consequence: every race in the cache (stuck guard, invalidate-loop,
concurrent refetches) is a bug that published SWR implementations have
documented fixes for, which we rediscover by bisection.

### Scope is per-connection, not per-channel

The SSE URL format takes one `scope=X` and many `scoped=Y` channel
names within that scope. A single connection can subscribe to many
channels under one resource scope, but cannot mix two resource scopes.

Floor that matches current UX (one resource viewer at a time). Triggers
for widening: a UI feature requiring two resource viewers
simultaneously, a headless client watching many resources in parallel,
or legitimate different-scope concurrent subscribe calls firing in
production.

### No channel-level authorization

Any authenticated user who subscribes to a channel receives everything
on that channel. Resources don't have per-user ACLs in the transport
layer. Handlers may enforce authorization in the handler body (e.g.
by checking `_userId`), but `/bus/subscribe` itself does not filter.
Genuine limitation for any multi-tenant deployment.

## Rules of thumb for consumer code

### Effects that subscribe MUST be idempotent across cleanup cycles

React Strict Mode double-invokes effects (mount → cleanup → mount) to
shake out cleanup bugs. Any code that interacts with the bus — calling
`subscribeToResource`, registering an event handler, wiring a ViewModel
— must survive this. Concretely:

- `subscribeToResource(X)` called twice in a row with the same `X` must
  be a no-op on the second call (ref-counted today; first call adds,
  second increments a count, both unsubscribes required before the
  scope is actually removed).
- A ViewModel whose factory captures props must be keyed on those
  props (`<Inner key={rId} />`) so the factory reruns when they change.
  `useViewModel`'s factory does NOT re-run across renders by design —
  see the tests in
  `packages/react-ui/src/hooks/__tests__/useViewModel.test.tsx` for
  the locked-in semantic.

### Request-response callers must handle response-lost

Because responses are at-most-once and a reconnect during the request
window drops them (HTTP-specific), any caller that must eventually
complete needs one of:

- A cache-layer refetch on reconnect (`BrowseNamespace`'s gap detection
  is the reference example).
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
- `packages/api-client/src/transport/http-transport.ts` — the HTTP
  implementation of `ITransport`.
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
- **2026-04-19** — `Last-Event-ID` resumption landed. Persisted events
  now carry `p-<scope>-<seq>` ids; scoped-subscribe requests with
  `Last-Event-ID` trigger event-store replay. `bus:resume-gap` is the
  server's signal that it couldn't cover the gap. Consumer contract
  changes: bare reconnects no longer require cache invalidation. Also:
  actor-vm now tracks all in-flight fetch controllers and aborts every
  previous one on new connect, closing an orphan-stream leak.
- **2026-04-19** — connection-state machine landed.
  `actor.connected$: Observable<boolean>` replaced with
  `actor.state$: Observable<ConnectionState>` (initial / connecting /
  open / reconnecting / degraded / closed). Transitions are enforced;
  `degraded` fires after 3 s in `reconnecting`, giving UI a
  non-timing-heuristic signal to differentiate mount churn from
  sustained disconnection.
- **2026-04-21** — client SSE parser state moved outside the
  `reader.read()` loop. Previously, assembly state reset on every
  chunk, silently dropping any event whose `data:` header and
  terminating blank line landed in different TCP reads. Contract
  change: the "Wire framing and client parser obligations" section
  now formally documents this requirement. Regression-tested.
- **2026-04-26** — scope narrowed to HTTP-specific. Shared transport
  guarantees moved to
  [`packages/core/docs/TRANSPORT-CONTRACT.md`](../../../packages/core/docs/TRANSPORT-CONTRACT.md).
  This doc now covers only HTTP + SSE wire concerns: schema validation
  at `/bus/emit`, `Last-Event-ID` resumption, the six-state connection
  machine, SSE parser chunking obligations, response-lost on reconnect,
  and the HTTP-specific known gaps.
