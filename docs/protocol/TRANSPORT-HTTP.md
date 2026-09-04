# HTTP Bus Gateway Contract

**Purpose**: the HTTP-specific contract for the bus gateway between the
browser (or any headless client) and the Semiont gateway. If the code
deviates from what's written here, the code is wrong — or this doc is
wrong and needs updating, deliberately. No third option.

Transport-agnostic guarantees (at-most-once emit, per-channel ordering,
`busRequest` semantics, `_userId` injection invariant) live in the
shared contract at
[TRANSPORT-CONTRACT.md](./TRANSPORT-CONTRACT.md).
This doc covers only what's specific to the HTTP + SSE wire.

Neighboring docs:

- [EVENT-BUS.md](./EVENT-BUS.md) — protocol semantics (channel naming,
  payload categories, correlation, scoping rules).
- [CHANNELS.md](./CHANNELS.md) — channel inventory (which channels
  carry what kind of payload, scoped vs. global).
- [TRANSPORT-CONTRACT.md](./TRANSPORT-CONTRACT.md) — wire-agnostic
  guarantees every `ITransport` honors.

## Non-goals

- **Not the protocol semantics.** Channel naming, payload shape, and
  scoping rules live in [EVENT-BUS.md](./EVENT-BUS.md).
- **Not the shared transport contract.** See
  [TRANSPORT-CONTRACT.md](./TRANSPORT-CONTRACT.md)
  for guarantees that every `ITransport` honors.
- **Not a wishlist.** This doc describes what *is*, not what should be.
  Known gaps are called out in a dedicated section so they can't be
  confused with guarantees.

## The two wire primitives

```
Browser / headless client                         Gateway
  │                                                  │
  │    POST /bus/emit                                │
  │    { channel, payload, scope? }  →  202          │
  │ ─────────────────────────────────────►           │
  │                                                  │
  │    POST /bus/subscribe                           │
  │    { global: [...], scoped: [{scope, channels,   │
  │      lastEventId?}, ...] }                       │
  │ ◄── event-stream ──────────────────────────────  │
  │                                                  │
```

- `POST /bus/emit` — fire-and-forget. Body is a single
  `{channel, payload, scope?}`. 202 on accepted; 400 on validation
  failure or unknown channel; 401 on auth failure.

- `POST /bus/subscribe` — long-lived SSE (the response streams). The
  JSON body is a **subscription matrix**: `global` channels plus any
  number of `scoped` entries — one per resource scope, each naming its
  channels and optionally that scope's resumption watermark
  (multi-resource scope, 2026-07-29). One connection holds many resource scopes at
  once. 400 on a malformed body, an empty matrix, duplicate scopes, or
  more than 512 scopes (warn-logged from 128).

Every event carries an `event:` line of `bus-event` and a `data:` line
of `{channel, payload, scope?}`.

No other transport is used for bus traffic. Regular HTTP is for auth,
health, and binary resources.

## Authentication and authorization

Both endpoints require a valid JWT (`Authorization: Bearer …`).

- 401: token missing, malformed, expired, or signed with a key the
  gateway doesn't recognize (e.g. the gateway was restarted with a
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
  `CHANNEL_SCHEMAS` — declared in [specs/src/bus/registry.json](../../specs/src/bus/registry.json), generated into `packages/core/src/bus-protocol.ts`;
  this is an HTTP-layer guard because the wire is untyped JSON.
  - Channels with a named schema: payload must match, or 400.
  - Channels with a `null` schema entry: no validation (compound /
    branded type not expressible as a single OpenAPI schema).
  - Channels not present in `CHANNEL_SCHEMAS`: 400 with "Unknown
    channel". The map's `satisfies Record<EventName, ...>` forces
    coverage of every `EventName` — a new channel added to `EventMap`
    but not `CHANNEL_SCHEMAS` is a build error.

### `POST /bus/subscribe`

- **At-most-once delivery with resumption for persisted events.** A
  connection that wasn't live at publication time doesn't see the live
  delivery, but persisted events can be replayed on reconnect. See
  "Event id and resumption" below.
- **Persisted domain events route by exactly one discipline.** Although
  `EventStore.appendEvent` publishes on BOTH the global bus AND the
  resource-scoped bus, the bridged (global) and resource-scoped channel
  sets are **disjoint**, and a subscription only delivers the channels
  it asked for. So a persisted event reaches a client via exactly one
  path: KB-global persisted events (`frame:*`) over the global
  subscription, resource-scoped persisted events (`mark:added`,
  `yield:created`, …) over the scope subscription. A client subscribed
  both globally and to the resource does **not** receive the same event
  twice — disjointness guarantees it (see "Event categorization and
  scope" below). The one residual overlap — a make-before-break
  reconnect — is handled by event-id dedup, described next.

#### Event id and resumption

Every event on the SSE stream carries an `id:` field of one of three
shapes:

| Shape | Meaning | Resumable |
|---|---|---|
| `p-<scope>-<seq>` | Persisted event, scoped. `<scope>` is the resource id, `<seq>` is `event.metadata.sequenceNumber`. | **Yes.** |
| `e-<channel>:<cid>` | Correlation reply (payload carries a `correlationId`). **Deterministic** — the same reply is tagged with the same id on every connection, so a make-before-break overlap dedups it to one emission. | No. |
| `e-<connectionId>-<counter>` | Any other ephemeral event (no `correlationId`). Unique per connection; no replay meaning. | No. |

Resumption is **per scope** (since 2026-07-29): clients track the
last persisted (`p-*`) id seen PER SCOPE and send each as the
`lastEventId` field on that scope's entry in the subscribe body —
there is no `Last-Event-ID` header. Ephemeral ids are never stored as
watermarks (the old single-header design let an ephemeral id displace
the persisted watermark — a silent replay-loss hole this shape closes).
For each scoped entry carrying a watermark:

1. If the watermark parses and its embedded scope matches the entry's
   `scope`, the server queries the event store for persisted events in
   that scope with `sequenceNumber > <seq>`, filtered to the entry's
   `channels`, and replays them before the live tail starts. Entries
   for OTHER scopes replay independently; entries without a watermark
   are fresh subscriptions — no replay, no gap event.
2. If replay can't cover the gap (retention window exceeded, scope
   mismatch, unparseable id, query error), the server emits a
   synthetic `bus:resume-gap` event carrying the reason and the
   ENTRY's scope. The client should treat this as a signal to fall
   back to blanket invalidation for that scope.

Clients that send no watermarks get live-only behavior.

### HTTP-specific quirk: response-lost during a genuine disconnect — NARROWED TO RETENTION BOUNDS

The shared contract publishes a `busRequest` reply exactly once, at
publish time. The historical quirk — connection lost during the request
window ⇒ reply published to a dead subscriber ⇒ 30s timeout with no
retry — has been closed in layers:

- A **channel-set change no longer causes this** (#847): those
  reconnects are make-before-break (see "Reconnect discipline" below),
  so the old connection stays live to deliver the in-flight result
  while the new one takes over.
- The **attach gate** (2026-07-29): no correlated emit leaves
  before the reply path is `'open'`.
- **Correlated-reply retention** (2026-07-29):
  the gateway retains recent replies (bounded: 60s TTL / 1024 entries,
  keyed by correlationId), `busRequest` registers its cid with the
  transport BEFORE emitting, and every subscribe body carries the
  outstanding cids as `pendingReplies` — so a reply published while
  the connection was genuinely down is REPLAYED on reconnect, with its
  deterministic `e-<channel>:<cid>` id (a copy that also arrived live
  dedups client-side, same as the make-before-break overlap).

What remains lost: a reply older than the retention TTL (the caller's
own 30s deadline passed long before), retention-cap eviction under
pathological load, and a gateway restart (in-memory buffer). A future
**multi-instance deployment is the named tripwire**: a reconnect landing
on a different replica finds no buffer, so replicas must not ship
without deciding sticky routing vs a shared retention store (see
TRANSPORT-CONTRACT.md § Delivery guarantees). Consumers keep their
defense-in-depth: the cache's bounded SWR retry (B14) and terminal
failure (B15) stay, but should fire approximately never.

`LocalTransport` doesn't have this failure mode — in-process
subscribers never disconnect during a call — and omits `trackReply`.

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
| `unauthenticated` | Not attempting: the token getter returns nothing, or returned a bearer the gateway refused with 401. The tick keeps polling the GETTER (no network) and the actor reconnects by itself the moment a usable, different credential appears. The refusal is on `errors$` as a `SseConnectError` carrying the status. |
| `closed` | `stop()` or `dispose()` was called. Terminal. |

Transitions are enforced by an internal helper. An invalid move is
logged and ignored — never thrown: `transition()` runs inside timer
callbacks (the reconnect and degraded timers), where a throw would be an
uncaught exception that kills a long-running host process (#844). A bad
edge is a bug, but degrading gracefully beats crashing a job.

Allowed transitions:

```
initial         → connecting | unauthenticated | closed
connecting      → open | reconnecting | unauthenticated | closed
open            → reconnecting | closed
reconnecting    → connecting | degraded | unauthenticated | closed
degraded        → connecting | reconnecting | unauthenticated | closed
unauthenticated → connecting | closed
closed          → (terminal)
```

`degraded → reconnecting` is the #844 recovery edge: a channel-set
change can schedule a reconnect while the connection is degraded.
`unauthenticated` is entered from any non-open state — at the gate
(empty or still-refused token) or when a connect lands 401 — and left
only for `connecting`, when the getter yields a usable, different
credential.

Gap detection is handled by the resumption protocol (see "Event id and
resumption"), not by consumers interpreting state edges.

### Reconnect discipline (client side)

The client-side `ActorStateUnit` handles three reconnect triggers:

1. **Server/network disconnect, or a refused connect.** The SSE read
   loop exits (or the subscribe POST answers non-2xx — surfaced on
   `errors$` as a `SseConnectError` carrying the status); state
   transitions to `reconnecting`; `connect()` is retried on an
   **equal-jitter exponential backoff**: delay ∈ [cap/2, cap] with
   cap = min(`reconnectMs`·2ⁿ, 60 s), n resetting on a successful
   open (SSE-AUTH-RESILIENCE D1a — the bound applies to ALL failure
   retries, not just auth, and jitter keeps N clients out of
   lockstep). If retrying takes longer than `DEGRADED_THRESHOLD_MS`,
   state enters `degraded`. **A 401 does not retry at all**: the
   refused bearer is remembered, state parks in `unauthenticated`,
   and the flat tick polls the token getter (no network) until a
   different, non-empty credential appears — one refused request per
   credential value, ever. Before staying parked, the actor consults
   the configured `tokenRefresher` **once per outage** — the same
   hook the HTTP `beforeRetry` path uses, no second refresh
   mechanism — and a successful refresh (the refresher's owner
   rotates the token source) reconnects immediately; a null/throwing
   refresher leaves the actor parked, and a successful open re-arms
   the once. The credential gate applies the same no-asking rule to
   an EMPTY token before the first byte is sent.
2. **Channel-set change** (`addChannels` / `removeChannels`). A new SSE
   is opened with the updated query string and, **only once it is
   `open`, the old one is marked superseded and LINGERS — still
   draining — for `LINGER_MS` (1 s) before being aborted** —
   make-before-break (#847) plus drain (starvation fix), so an
   ephemeral result in flight during the swap is delivered on the
   still-live old connection instead of dropped in a gap, and replies
   already written to the old socket but not yet read survive the
   handoff. Reconnects are **debounced 100 ms** so React Strict Mode's
   mount → cleanup → mount sequence collapses into one reconnect. State
   cycles `open → reconnecting → connecting → open` without reaching
   `degraded` (the round-trip is sub-second). A superseded connection's
   read loop ending — naturally or via the linger abort — does NOT
   restart the reconnect machinery; that belongs to the live connection
   only.
3. **Explicit `stop()` / `dispose()`.** State transitions to `closed`;
   the observable completes. No retry.

On every reconnect, the client sends each scope's last persisted id as
that entry's `lastEventId` in the subscribe body. For a clean reconnect
(no persisted events missed), the server replays nothing and live
delivery resumes.
Consumers should NOT revalidate caches on the `reconnecting → open`
transition — that work is driven by `bus:resume-gap`, which the server
emits only when it genuinely can't cover the gap.

**Connection handoff (make-before-break + linger-drain).** On a
channel-set change the client keeps the previous connection(s) live
until the new fetch resolves (#847), then supersedes them and keeps
them **draining for `LINGER_MS` before the abort** — aborting at the
instant of handover discarded replies already buffered on the old
socket but not yet read by the client's read loop (the
N-concurrent-loaders starvation incident, 2026-07-05). A genuine
disconnect or the initial connect has nothing live to preserve, so it
aborts up front. Either way the client tracks SSE fetch controllers as
a set and converges to a single live stream within the drain window:
the newest connection supersedes every prior controller, so rapid
channel-set changes racing each other can't accumulate orphaned
streams.

### Abort discipline (drain-over-abort)

`abort()` means "discard these bytes" — any buffered-but-unread event
on the aborted stream is silently lost, and correlated replies are
non-replayable by design (`e-*` ids). So the rule:

> **A connection is retired by drain, never by a handover abort.
> `abort()` is reserved for (a) explicit consumer cancellation and
> (b) terminal teardown (`stop()`/`dispose()`), where no consumer
> remains to receive the bytes.**

Audit of every live `.abort()` site (2026-07-05):

| Site | Class | Verdict |
|---|---|---|
| `actor-state-unit.ts` `disconnect()` | terminal teardown (`stop`/`dispose`) | sanctioned |
| `actor-state-unit.ts` `connect(keepPrevious=false)` up-front abort | drop-recovery / orphan collapse — the pipe is already dead (read loop exited) or a raced orphan; resumption + the cache's bounded SWR retry cover the gap | sanctioned |
| `actor-state-unit.ts` linger-expiry abort | the drain rule itself (drain-then-abort) | sanctioned |
| `http-transport.ts` `sseProgressStream` unsubscribe | explicit consumer cancellation (progress is ephemeral UI feedback; the server-side operation completes regardless) | sanctioned |
| `http-content-transport.ts` XHR `onAbort` | explicit consumer cancellation (caller's `AbortSignal`) | sanctioned |
| `sdk/namespaces/yield.ts` upload teardown | explicit consumer cancellation (unsubscribe-before-finished is documented as cancel) | sanctioned |

The one historical violator — the immediate handover abort in
`connect(keepPrevious=true)` — was converted to linger-drain by the
starvation fix. Any NEW `.abort()` call must be classifiable as
consumer-cancel or terminal teardown; a lifecycle-handover abort is the
buffered-loss bug class reintroduced.

The rule is pinned as liveness axiom **L3** (enforced by
`assertExactlyOnceDelivery` from `@semiont/core/testing`): an event written to any *live*
connection's stream is delivered to `on$` subscribers exactly once,
wherever a handover / reconnect / scope change lands relative to it.
The property suite
([actor-liveness.property.test.ts](../../packages/http-transport/src/transport/__tests__/actor-liveness.property.test.ts))
fast-check-schedules SSE delivery against handover timing over the real
actor; transport rewrites (e.g. the multi-resource-scope rewrite) must
keep it green.

During the brief handoff overlap the same live event can arrive on both
connections. The client dedups by event id (`seenEventIds` in the
actor-state-unit):

- Persisted ids (`p-<scope>-<seq>`) are stable across connections → deduped to a single emission.
- Correlation-reply ids (`e-<channel>:<cid>`) are deterministic → **also deduped**, so a reply landing on both the old and new connection is delivered once. (This closed a real duplicate-delivery bug: a per-connection id tagged the same reply differently on each connection and the dedup missed it — see the gateway `writeBusEvent` rationale in `apps/gateway/src/routes/bus.ts`.)
- Other ephemeral ids (`e-<connectionId>-<counter>`) carry no `correlationId` and remain per-connection, so they aren't deduped — but their consumers tolerate a rare double (cache invalidations and job-completion are idempotent/terminal).

## Wire framing and client parser obligations

The SSE stream is plain `text/event-stream`. Each event is written as:

```
event: bus-event
id: <ephemeral or persisted id>
data: <JSON-stringified {channel, payload, scope?}>
<blank line>
```

The gateway writes each event through Hono's `streamSSE` with no
compression and no chunked-JSON framing — `data:` is always exactly
one line, followed by one terminating blank line.

**Client parsers must hold event-assembly state across `reader.read()`
boundaries.** A single SSE event can exceed the first TCP segment (a
full `browse:resource-result` carries the resource plus annotations,
easily past the first-chunk size). The reference parser in
`packages/http-transport/src/state units/domain/actor-state-unit.ts` keeps
`currentEvent` / `currentData` / `currentId` outside its read loop;
any replacement must do the same, or any event that chunks across
reads is silently dropped — the `data:` header lands in one chunk and
the blank-line terminator in the next, and resetting state per-chunk
breaks dispatch.

This constraint is tested by
`packages/http-transport/src/state units/domain/__tests__/actor-state-unit.test.ts`
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

System-wide broadcasts (`beckon:focus`, `frame:entity-type-added`, etc.)
are a special case of correlation-ID responses in terms of scoping:
they go global, but they're received by every connected client, not
filtered.

The global (bridged) and resource-scoped delivery sets are **disjoint**
by construction and by invariant test. The client subscribes globally to
`BRIDGED_CHANNELS` and per-resource to
`RESOURCE_SCOPED_CHANNELS = PERSISTED_EVENT_TYPES.filter(t => !BRIDGED_CHANNELS.includes(t))`
(plus the currently empty `RESOURCE_BROADCAST_TYPES`). A channel in both
sets would be forwarded twice — once globally, once scoped, with
different ids — a duplicate on the client bus; the `filter` and the
`BRIDGED_CHANNELS ∩ RESOURCE_SCOPED_CHANNELS === ∅` test prevent it.

This table is the single source of scope truth. Any new channel must
fit in one of the three rows. See [EVENT-BUS.md § Resource scoping](./EVENT-BUS.md#resource-scoping).

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
  They must be UUIDs or equivalently-unique. The gateway does not
  deduplicate them.

## Known gaps (deliberately surfaced)

Open limitations of the HTTP contract. Listed so future work can
reference them specifically instead of rediscovering them.

### Cache layer reimplements SWR / React Query

`packages/http-transport/src/namespaces/browse.ts` implements
stale-while-revalidate, in-flight dedup, and event-driven invalidation
by hand. See
[`packages/sdk/docs/CACHE-SEMANTICS.md`](../../packages/sdk/docs/CACHE-SEMANTICS.md).
The constraint we're honoring is framework-agnosticism — the same
client is used by React, the MCP server, and workers.

Consequence: every race in the cache (stuck guard, invalidate-loop,
concurrent refetches) is a bug that published SWR implementations have
documented fixes for, which we rediscover by bisection.

### ~~Scope is per-connection, not per-channel~~ — RESOLVED

**RESOLVED (2026-07-29) by the multi-resource-scope rewrite.** The subscribe body
is a matrix: one connection subscribes any number of resource scopes
simultaneously, each with its own channel set and resumption
watermark. The transport ref-counts subscriptions per resource and
distinct resources compose — the old one-scope floor (and the
`subscribeToResource` different-resource throw, and the sdk's interim
scope-contention degradation) no longer exist. The widening triggers
this entry named all fired via the embeddable viewer's
resource-per-chat-message pattern.

### No channel-level authorization

Any authenticated user who subscribes to a channel receives everything
on that channel. Resources don't have per-user ACLs in the transport
layer. Handlers may enforce authorization in the handler body (e.g.
by checking `_userId`), but `/bus/subscribe` itself does not filter.
Genuine limitation for any multi-tenant deployment.

## Rules of thumb for consumer code

### Effects that subscribe MUST be idempotent across cleanup cycles

React Strict Mode double-invokes effects (mount → cleanup → mount) to
shake out cleanup bugs. Any code that interacts with the bus —
subscribing to a resource's `browse.*` live queries, registering an
event handler, wiring a StateUnit — must survive this. Concretely:

- Subscribing to `browse.*(X)` twice for the same resource `X` must
  ref-count the scope: the SDK calls the transport's internal
  `subscribeToResource(X)` per subscription; the first acquires the SSE
  scope, the rest increment a count, and the scope is removed only after
  every subscription is torn down (freshness follows observation; #847).
- A StateUnit whose factory captures props must be keyed on those
  props (`<Inner key={rId} />`) so the factory reruns when they change.
  `useStateUnit`'s factory does NOT re-run across renders by design —
  see the tests in
  `packages/react-ui/src/hooks/__tests__/useStateUnit.test.tsx` for
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

- `apps/gateway/src/routes/bus.ts` — the `/bus/emit` and
  `/bus/subscribe` routes.
- `specs/src/bus/registry.json` — the authority: channels, payloads, operations.
- `packages/core/src/bus-protocol.ts` — GENERATED `EventMap`, `CHANNEL_SCHEMAS`,
  `EmittableChannel`, `RESOURCE_BROADCAST_TYPES`.
- `packages/http-transport/src/transport/http-transport.ts` — the HTTP
  implementation of `ITransport`.
- `packages/http-transport/src/state units/domain/actor-state-unit.ts` — the
  client-side SSE reader, reconnect logic, channel-set management.
- `packages/http-transport/src/bus-request.ts` — correlation-ID matcher.
- `packages/event-sourcing/src/event-store.ts` — persisted-event
  dual-publish (global + scoped).

## Revision log

A deliberate choice to keep this as a separate section so changes to
the contract are visible.

- **2026-07-29** — correlated-reply retention landed. The gateway retains recent replies (60s TTL,
  1024-entry FIFO); the subscribe body's new `pendingReplies` field
  (cap 256) names the cids a client still awaits and the server replays
  matches with their deterministic ids. `busRequest` tracks its cid via
  the transport's optional `trackReply` BEFORE emitting (a reconnect
  body built mid-emit must already carry it) and releases on every
  settle path. The "response-lost during a genuine disconnect" quirk
  narrows to retention bounds; B14/B15 remain as defense in depth.
- **2026-07-29** — multi-resource scope landed. `/bus/subscribe` is
  POST with a JSON subscription matrix (`global` + N `scoped` entries);
  the GET query form and the `Last-Event-ID` header are GONE (clean
  cutover — resumption watermarks ride per-scope on the body, closing
  the ephemeral-displaces-watermark replay-loss hole). One connection
  holds many resource scopes; the transport ref-counts per resource and
  distinct resources compose. Client-side: scope removals reconnect
  lazily (`lazyRemoveMs` hysteresis) so hover churn doesn't storm;
  additions keep the 100 ms debounce; make-before-break + linger-drain
  unchanged. Scope cap 512/connection.
- **2026-04-19** — initial draft, reflecting the contract after the
  bus-simplification work plus the reconnect debounce fix.
- **2026-04-19** — `Last-Event-ID` resumption landed. Persisted events
  now carry `p-<scope>-<seq>` ids; scoped-subscribe requests with
  `Last-Event-ID` trigger event-store replay. `bus:resume-gap` is the
  server's signal that it couldn't cover the gap. Consumer contract
  changes: bare reconnects no longer require cache invalidation. Also:
  actor-state-unit now tracks all in-flight fetch controllers and aborts every
  previous one on new connect, closing an orphan-stream leak.
- **2026-04-19** — connection-state machine landed.
- **2026-07-05** — linger-drain handoff landed (starvation fix P2):
  superseded connections drain `LINGER_MS` before abort; their read-loop
  exit no longer restarts reconnect. New **Abort discipline
  (drain-over-abort)** section with the site audit; the rule is the
  contract for any future `.abort()` call.
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
  [TRANSPORT-CONTRACT.md](./TRANSPORT-CONTRACT.md).
  This doc now covers only HTTP + SSE wire concerns: schema validation
  at `/bus/emit`, `Last-Event-ID` resumption, the six-state connection
  machine, SSE parser chunking obligations, response-lost on reconnect,
  and the HTTP-specific known gaps.
