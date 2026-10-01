# HTTP Bus Gateway Contract

**Purpose**: the HTTP-specific contract for the bus gateway between the
browser (or any headless client) and the Semiont gateway. If the code
deviates from what's written here, the code is wrong — or this doc is
wrong and needs updating, deliberately. No third option.

The OpenAPI document ([specs/src/openapi.json](../../specs/src/openapi.json))
is the other half of this contract, and the half a machine reads: every
route, every status each answers and its body, the headers, the stream's
messages and id formats, the limits (`x-semiont-limits`, `maxItems`), and
the claims a token must carry (the `bearerAuth` scheme). This doc states
what a schema cannot: order, entitlement, recovery, and what the gateway
does on its own initiative. The gateway conformance suite
(`tests/conformance/gateway`) checks a running gateway against both.

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
  │    { channel, payload, scope?,                   │
  │      clientId?, correlationId? }  →  202         │
  │ ─────────────────────────────────────►           │
  │                                                  │
  │    POST /bus/subscribe                           │
  │    { clientId, global: [...],                    │
  │      scoped: [{scope, channels, lastEventId?}],  │
  │      pendingReplies: [...] }                     │
  │ ◄── event-stream ──────────────────────────────  │
  │                                                  │
```

- `POST /bus/emit` (BusEmitRequest) — fire-and-forget. 202 with
  `BusEmitAccepted` (`subscribers`: how many observers the target had at
  dispatch, absent when the signal plane cannot count them); 400 when the
  body or the channel's payload does not validate or the channel is not in
  the registry; 401; 409 when a request's `correlationId` is already
  claimed; 429 when the client already has as many unanswered requests as
  it may; 503 when the signal plane's broker is not connected — the event
  is refused, never accepted and lost.

- `POST /bus/subscribe` (BusSubscribeRequest) — a long-lived SSE stream.
  The JSON body is a **subscription matrix**: `global` channels plus any
  number of `scoped` entries — one per resource scope, each naming its
  channels and optionally that scope's resumption watermark — the
  client's `clientId`, and the correlation ids it still awaits
  (`pendingReplies`). 400 on a body that does not validate, an empty
  matrix, or a scope named twice.

The stream carries two messages (BusStreamMessage): `bus-event`, whose
`data:` line is a JSON BusFrame `{channel, correlationId?, payload,
scope?}` and whose `id:` is one of the three formats below; and `ping`,
the heartbeat, with an empty `data:` and no id.

No other transport is used for bus traffic. Regular HTTP is for auth,
health, and binary resources.

## Every response

- **Errors are JSON.** Every non-2xx response, on every route, is
  `application/json` with an `ErrorResponse` body (`{error, code?, hint?}`)
  — including a path the gateway does not serve, which answers 404.
- **CORS is open and credential-less.** `Access-Control-Allow-Origin: *`
  and no `Access-Control-Allow-Credentials`: the API is bearer-only, so no
  origin can ride a browser's ambient credentials.
- **Security headers.** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` (a
  browser honours it only over HTTPS), `X-XSS-Protection: 1; mode=block`, a
  `Content-Security-Policy` of `default-src 'none'; frame-ancestors 'none';
  base-uri 'none'; form-action 'none'`, and a `Permissions-Policy` that
  disables every browser feature.
- **`X-Request-ID`** names the request in the gateway's logs.

## Limits

The numbers live in the spec, not here:

| Limit | Where | Past it |
|---|---|---|
| A JSON request body | each operation's `x-semiont-limits.maxBodyBytes` | 413, unread when its Content-Length says so |
| Scopes on one connection | `BusSubscribeRequest.scoped.maxItems` | 400 |
| Pending replies named on subscribe | `BusSubscribeRequest.pendingReplies.maxItems` | 400 |
| Unanswered requests per client | the same `maxItems` | 429 `unanswered-requests` on the next emit; `Retry-After` is when the oldest expires |
| Streams one principal holds, across replicas | `/bus/subscribe` `x-semiont-limits.streamsPerPrincipal` | 429 `streams` |
| Emits one principal makes, per gateway process | `/bus/emit` `x-semiont-limits.emitsPerPrincipal` (a rate and a burst) | 429 `emit-rate` |
| Bytes queued for all of one gateway's streams | GatewayConfig `capacity.queuedBytes` | 503 `capacity` on the next `/bus/subscribe` |
| Connections one gateway holds open | GatewayConfig `capacity.connections` | the connection is closed unanswered |
| How long a claim lasts unanswered | `/bus/emit` `x-semiont-limits.claimSeconds` | the claim expires; its reply is no longer routed |
| How long a reply is retained | `/bus/subscribe` `x-semiont-limits.replyRetentionSeconds` | `pendingReplies` no longer recovers it |
| Heartbeat interval | `x-semiont-limits.heartbeatSeconds` | — |
| Bytes written to a connection and not yet taken | `x-semiont-limits.pendingWriteBytes` | the connection is closed |
| Live frames arriving during a replay | `x-semiont-limits.replayBufferEvents` | the connection is closed |

A closed connection is not an error the client handles: it reconnects
with its watermarks and `pendingReplies` and loses nothing either
covers.

A limit on a principal does not ask whether it is a person or an agent. It
states a baseline and a coefficient per role, and a role changes the
coefficient whoever holds it: `semiont-service` and `semiont-worker` are
unlimited. A refusal by a limit names it in the body's `code` and says in
`Retry-After` how many seconds to wait; the clients wait at least that long.

## Authentication and authorization

Both endpoints require a valid JWT (`Authorization: Bearer …`); the
`bearerAuth` scheme in the spec is the claims contract.

- 401: token missing, malformed, expired, or signed with a key the
  gateway doesn't recognize. The `WWW-Authenticate` challenge names the
  resource metadata (`resource_metadata="<origin>/.well-known/oauth-protected-resource"`),
  with `error="invalid_token"` when a token was presented and refused.
  With no token, the body's `hint` names the header to send. A refused
  token is told only that (`Invalid token`): why it did not verify is in
  the gateway's log, not the reply. A verified token that lacks the role
  an operation requires is told which role.
- 403: not used. All authenticated users see all channels.
  That's a known gap — see "Known gaps" below.

The gateway stamps `_userId` (the verified principal's DID) and `_roles`
(the token's capabilities) onto every emitted payload, clearing anything
the caller wrote there. Handlers read `command._userId`; it's the only
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
- **Claims.** A registry operation's request carrying a `correlationId`
  claims that id for its `clientId` and the verified principal before it
  is published — `clientId` is required then (400 without it). The claim
  is what routes the reply: a frame on a correlated channel reaches only
  connections subscribed under the same `clientId` by the same principal.
  A live id claimed twice is refused (409); a client with as many
  unanswered requests as `pendingReplies` may name is refused (429). A
  claim is released by its first reply, or expires after `claimSeconds`.
  Claims live in a table every gateway replica on one broker shares, so a
  reply reaches its requester whichever replica each is connected to.
- **Profile.** When the channel is one whose registry `effect` writes and
  the principal is a person whose token carries `name`, the gateway also
  publishes `person:profile` `{_userId, name}` — how the record learns
  what a person is called.
- **An unanswerable request fails fast.** When the plane can count
  observers (the in-process plane) and a request with a `correlationId`
  reaches none, the gateway publishes the operation's own failure channel
  with the request's fields, `code: "peer-unavailable"` and a message,
  so the caller learns in milliseconds that the service that answers it
  is not connected. A broker plane cannot count, so there the caller
  waits out its deadline.

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
| `e-<channel>:<cid>` | A frame carrying a `correlationId`. **Deterministic** — the same reply is tagged with the same id on every connection, so a make-before-break overlap, or a retained reply replayed on reconnect, dedups to one emission. | No. |
| `e-<connectionId>-<counter>` | Any other frame. Unique per connection; no replay meaning. | No. |

The patterns are `PersistedEventId`, `ReplyEventId` and `EphemeralEventId`
in the spec. The persisted form is used exactly when the frame carries a
`scope` and its payload a `metadata.sequenceNumber`.

Resumption is **per scope**: clients track the last persisted (`p-*`)
id seen PER SCOPE and send each as the `lastEventId` field on that
scope's entry in the subscribe body — there is no `Last-Event-ID`
header. Ephemeral ids are never stored as watermarks: one displacing a
persisted watermark is a silent replay-loss hole.
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

**The order on the stream** is fixed: for each scoped entry with a
watermark, in the order the entries were sent, its replay (or its gap
event; for `retention-exceeded`, the gap, then the replay of what the
record still holds); then every retained reply `pendingReplies` names; then the live
frames that arrived while the replay ran, less any persisted event the
replay already delivered; then the live tail. The first `ping` follows
the catch-up.

**Presence.** Opening a stream publishes `session:joined` and closing
it `session:left`, each `{participant, connectionId}` — the principal's
DID and a per-connection id, since one person with two tabs is two
connections.

### HTTP-specific quirk: response-lost during a genuine disconnect — bounded by retention

The shared contract publishes a `busRequest` reply exactly once, at
publish time, so a connection lost inside the request window would leave
the reply published to a dead subscriber and the caller waiting out its
30s deadline with no retry. Three mechanisms bound that:

- **Make-before-break reconnects**: a channel-set change keeps the old
  connection live to deliver the in-flight result while the new one
  takes over (see "Reconnect discipline" below).
- The **attach gate**: no correlated emit leaves before the reply path
  is `'open'`.
- **Correlated-reply retention**: the gateway retains the reply to
  every claimed request for `replyRetentionSeconds`, keyed by
  correlationId; `busRequest` registers its cid with the transport
  BEFORE emitting, and every subscribe body carries the outstanding cids
  as `pendingReplies` — so a reply published while the connection was
  genuinely down is REPLAYED on reconnect, with its deterministic
  `e-<channel>:<cid>` id (a copy that also arrived live dedups
  client-side, same as the make-before-break overlap). Only the client
  and principal that made the request can recover it.

Under the NATS signal plane, claims and retained replies live in the
broker's key-value tables, which every replica shares: a reconnect
landing on another replica, or on a restarted one, recovers the same
replies. Under the in-process plane they live in the one gateway
process and a restart loses them. What remains lost: a reply older than
the retention window (the caller's own 30s deadline passed long
before). Consumers keep their defense-in-depth: the cache's bounded SWR
retry (B14) and terminal failure (B15) stay, but should fire
approximately never.

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
| `unauthenticated` | Not attempting: the token getter returns nothing, or returned a bearer the gateway refused with 401. The tick keeps polling the GETTER (no network) and the actor reconnects by itself the moment a usable, different credential appears. The refusal is on `errors$` as an `APIError` carrying the status and its code. |
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
   `errors$` as an `APIError` carrying the status and its code); state
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

Every live `.abort()` site:

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
connection's stream is delivered to `stream` subscribers exactly once,
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
- Correlation-reply ids (`e-<channel>:<cid>`) are deterministic → **also deduped**, so a reply landing on both the old and new connection is delivered once. (This closed a real duplicate-delivery bug: a per-connection id tagged the same reply differently on each connection and the dedup missed it — see how the gateway stamps ids in `apps/gateway/src/routes/stream.rs`.)
- Other ephemeral ids (`e-<connectionId>-<counter>`) carry no `correlationId` and remain per-connection, so they aren't deduped — but their consumers tolerate a rare double (cache invalidations and job-completion are idempotent/terminal).

## Wire framing and client parser obligations

The SSE stream is plain `text/event-stream`. Each event is written as:

```
event: bus-event
id: <ephemeral or persisted id>
data: <JSON-stringified {channel, correlationId?, payload, scope?}>
<blank line>
```

and the heartbeat as:

```
event: ping
data:
<blank line>
```

No compression and no chunked-JSON framing — `data:` is always exactly
one line, followed by one terminating blank line. A client ignores an
`event` it does not know.

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
| Correlation-ID response | None | Only the connections of the `clientId` and principal that claimed its correlationId. |
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
- Every SSE event is live unless delivered as part of a replay: a
  scope's persisted events after the `lastEventId` its entry carried, or
  a retained reply `pendingReplies` named. Nothing else is replayed.
- A bare reconnect (no gap) requires no cache action. A gap the server
  couldn't cover arrives as a `bus:resume-gap` event; on that event,
  the consumer must revalidate state for the affected scope.
- `busRequest` has a 30s timeout and no retry. A reconnect during the
  request window loses nothing while the reply is retained; a caller
  that must complete past that still needs (a) a cache-layer refetch,
  (b) an explicit retry on timeout, or (c) acceptance that the operation
  is fire-and-forget.
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

### No channel-level authorization

Any authenticated user who subscribes to a broadcast channel receives
everything on it; only correlated replies are routed to their requester.
Resources don't have per-user ACLs in the transport layer. Handlers may enforce authorization in the handler body (e.g.
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

- `apps/gateway/src/routes/bus.rs` and `apps/gateway/src/routes/stream.rs` —
  the `/bus/emit` and `/bus/subscribe` routes.
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
