# HTTP Transport

What the HTTP wire adds to the [transport contract](./TRANSPORT-CONTRACT.md):
the two routes that carry the bus, the ids on the stream, the order of a
replay, how a subscription is handed over, the limits, and what a client
must do to keep the contract's promises over a connection that can drop.
The contract states what is promised. This document states how HTTP keeps
it.

If the code deviates from what is written here, the code is wrong, or this
document is wrong and is corrected deliberately. There is no third option.

The OpenAPI document ([specs/src/openapi.json](../../specs/src/openapi.json))
is the other half, and the half a machine reads: every route, every status
each answers and its body, the headers, the stream's messages and id
formats, the limits (`x-semiont-limits`, `maxItems`), and the claims a
token must carry (the `bearerAuth` scheme). This document states what a
schema cannot: order, entitlement, recovery, and what each side does on
its own initiative.

**How this document is held.** As in the contract, each rule ends with
*Held by* and what fails when it is broken: a file of the gateway suite
([`tests/conformance/gateway`](../../tests/conformance/gateway/README.md)),
which checks a running gateway against this document and the spec; a case
of the SDK suite ([`tests/conformance/sdk`](../../tests/conformance/sdk/README.md)),
which checks every SDK; or a test of the reference client. "Held by no
case" marks a rule nothing checks.

Neighbouring documents: [EVENT-BUS.md](./EVENT-BUS.md) (channel naming,
payloads, scoping), [CHANNELS.md](./CHANNELS.md) (the channel inventory).

## The two wire primitives

```
Client                                             Gateway
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

- `POST /bus/emit` (BusEmitRequest) — one frame out. 202 with
  `BusEmitAccepted` (`subscribers`: how many observers the target had at
  dispatch, absent when the signal plane cannot count them); 400 when the
  body or the channel's payload does not validate or the channel is not in
  the registry; 401; 409 when a request's `correlationId` is already
  claimed; 429 when a limit refuses it; 503 when the signal plane's broker
  is not connected — the frame is refused, never accepted and lost.

- `POST /bus/subscribe` (BusSubscribeRequest) — a long-lived SSE stream.
  The JSON body is a **subscription matrix**: `global` channels plus any
  number of `scoped` entries — one per resource scope, each naming its
  channels and optionally that scope's position — the client's `clientId`,
  and the correlation ids it still awaits (`pendingReplies`). 400 on a body
  that does not validate, an empty matrix, or a scope named twice.

The stream carries two messages (BusStreamMessage): `bus-event`, whose
`data:` line is a JSON BusFrame `{channel, correlationId?, payload,
scope?}` and whose `id:` is one of the three formats below; and `ping`,
the heartbeat, with an empty `data:` and no id.

No other transport is used for bus traffic. Regular HTTP is for
credentials, health, and a resource's bytes.

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

*Held by `gateway/edge.test.ts`, `gateway/spec-derived.test.ts`.*

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

A closed connection is not an error the client handles: it reopens its
stream with each scope's position and its `pendingReplies`, and loses
nothing either covers.

A limit on a principal does not ask whether it is a person or an agent. It
states a baseline and a coefficient per role, and a role changes the
coefficient whoever holds it: `semiont-service` and `semiont-worker` are
unlimited. A refusal by a limit names it in the body's `code` and says in
`Retry-After` how many seconds to wait; a client waits at least that long.

*Held by `gateway/spec-derived.test.ts`, `gateway/emit.test.ts`, `gateway/principal-limits.test.ts`, `gateway/capacity.test.ts`, `gateway/bounds.test.ts`, `gateway/replicas.test.ts`, `sdk/wire/emit-rate-limited`, `sdk/wire/stream-rate-limited`.*

## Authentication and authorization

Both routes require a valid JWT (`Authorization: Bearer …`); the
`bearerAuth` scheme in the spec is the claims contract.

- 401: token missing, malformed, expired, or signed with a key the
  gateway does not recognise. The `WWW-Authenticate` challenge names the
  resource metadata (`resource_metadata="<origin>/.well-known/oauth-protected-resource"`),
  with `error="invalid_token"` when a token was presented and refused.
  With no token, the body's `hint` names the header to send. A refused
  token is told only that (`Invalid token`): why it did not verify is in
  the gateway's log, not the reply. A verified token that lacks the role
  an operation requires is told which role.
- 403: not used. Every authenticated principal may subscribe to every
  broadcast channel. See "Known gaps".

The gateway stamps `_userId` (the verified principal's DID) and `_roles`
(the token's capabilities) onto every emitted payload, clearing anything
the caller wrote there. This is the contract's identity rule; the gateway
is its mechanism over HTTP.

*Held by `gateway/tokens.test.ts`, `gateway/edge.test.ts`, `gateway/emit.test.ts`.*

## The gateway

### POST /bus/emit

- **Schema validation.** Every inbound payload is validated against the
  schema the registry names for its channel
  ([specs/src/bus/registry.json](../../specs/src/bus/registry.json)): a
  channel with a named schema must match it, or 400; a channel the
  registry gives no schema is not validated; a channel not in the registry
  is a 400.
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
- **The count.** `subscribers` is how many connections the frame's channel
  and scope reached, and is present only when the signal plane can count.
- **Profile.** When the channel is one whose registry `effect` writes and
  the principal is a person whose token carries `name`, the gateway also
  publishes `person:profile` `{_userId, name}` — how the record learns
  what a person is called.
- **An unanswerable request fails fast.** When the plane can count
  observers (the in-process plane) and a request with a `correlationId`
  reaches none, the gateway publishes the operation's own failure channel
  with the request's fields, `code: "peer-unavailable"` and a message, to
  the requester only. A broker plane cannot count, so there the caller
  waits out its deadline.
- **A broker that is down refuses.** While the signal plane's broker is
  not connected an emit is refused 503, never accepted and lost.

*Held by `gateway/emit.test.ts`, `gateway/replicas.test.ts`, `gateway/outage.test.ts`, `sdk/wire/request-unanswerable`.*

### POST /bus/subscribe

- **What reaches which connection.** An unscoped frame reaches the
  connections whose `global` list names its channel. A scoped frame
  reaches only the connections holding that scope, and arrives tagged with
  it. A correlated frame reaches only the connections of the `clientId`
  and principal that claimed its id.
- **One connection, many scopes.** One stream holds global channels and
  any number of scopes at once; each scope's frames arrive under its own
  tag, and each scope resumes on its own.
- **Presence.** Opening a stream publishes `session:joined` and closing it
  `session:left`, each `{participant, connectionId}` — the principal's DID
  and a per-connection id, since one person with two tabs is two
  connections.
- **Heartbeat.** A `ping` follows the catch-up at once, then one every
  `heartbeatSeconds`.

*Held by `gateway/stream.test.ts`.*

#### Event id and resumption

Every frame on the stream carries an `id:` of one of three formats, and
the format is the frame's delivery class
([TRANSPORT-CONTRACT.md § Delivery](./TRANSPORT-CONTRACT.md#delivery)):

| Format | Spec pattern | Class | What it is |
|---|---|---|---|
| `p-<scope>-<seq>` | `PersistedEventId` | positioned | An event of the record, delivered on its resource's scope. `<scope>` is the resource id, `<seq>` its `metadata.sequenceNumber`. The same on every connection. |
| `e-<channel>:<correlationId>` | `ReplyEventId` | correlated | A frame carrying a `correlationId`. The same on every connection it reaches, and when it is sent again. |
| `e-<connectionId>-<counter>` | `EphemeralEventId` | passing | Any other frame. Unique to the connection that carried it. |

The persisted format is used exactly when the frame carries a `scope` and
its payload a `metadata.sequenceNumber`.

Resumption is **per scope**. A client tracks the last `p-*` id it
delivered on each scope and sends each as `lastEventId` on that scope's
entry in the subscribe body. There is no `Last-Event-ID` header. For each
scoped entry carrying one:

1. If it parses and its embedded scope matches the entry's `scope`, the
   gateway reads the record for that scope's events with
   `sequenceNumber > <seq>`, filtered to the entry's `channels`, and
   replays them before the live tail. Other entries replay independently;
   an entry with no `lastEventId` is a fresh subscription — no replay, no
   gap.
2. If replay cannot cover the gap, the gateway emits `bus:resume-gap`
   carrying the entry's scope, the `lastEventId` it was given, and a
   reason: `unparseable-last-event-id`, `scope-mismatch`,
   `retention-exceeded` or `query-error`.

**The order on the stream** is fixed: for each scoped entry with a
`lastEventId`, in the order the entries were sent, its replay (or its gap;
for `retention-exceeded`, the gap, then the replay of what the record
still holds); then every retained reply `pendingReplies` names; then the
live frames that arrived while the replay ran, less any event the replay
already delivered; then the live tail. The first `ping` follows the
catch-up.

*Held by `gateway/stream.test.ts`, `gateway/bounds.test.ts`, `sdk/wire/resumption`.*

### Correlated-reply retention

A reply is published once. So that a requester whose stream is down at
that moment still receives it, the gateway retains the reply to every
claimed request for `replyRetentionSeconds`, keyed by its `correlationId`,
and sends it again to a stream that names the id in `pendingReplies` —
under the same `e-<channel>:<correlationId>` id, so a copy that also
arrived live is recognised. Only the client and principal that made the
request can recover it, and recovery returns the first reply.

Under the NATS signal plane, claims and retained replies live in the
broker's key-value tables, which every replica shares: a stream reopened
on another replica, or on a restarted one, recovers the same replies.
Under the in-process plane they live in the one gateway process, and a
restart loses them. A reply older than the retention window is not
recovered; its request has timed out long before.

*Held by `gateway/stream.test.ts`, `gateway/replicas.test.ts`, `sdk/wire/pending-replies`.*

## The client

What a client does so that the contract holds over a connection that can
drop. The timing named here is
[`specs/src/client/timing.json`](../../specs/src/client/timing.json).

### Connection lifecycle

| State | Meaning |
|---|---|
| `initial` | Before the client has started its stream. |
| `connecting` | A subscribe request is in flight and no stream is live. |
| `open` | A stream is live. A changed subscription is handed to a new stream while this state holds: it is left only when the stream drops. |
| `reconnecting` | The stream dropped, or a connect failed with none live; the client is retrying. |
| `degraded` | Has been `reconnecting` for longer than `degradedThresholdMs`. |
| `unauthenticated` | Not attempting: the client has no token, or the gateway refused the one it has with 401. |
| `closed` | The client was stopped or disposed. Terminal. |

```
initial         → connecting | unauthenticated | closed
connecting      → open | reconnecting | unauthenticated | closed
open            → reconnecting | closed
reconnecting    → connecting | degraded | unauthenticated | closed
degraded        → connecting | unauthenticated | closed
unauthenticated → connecting | closed
closed          → (terminal)
```

`open` is reported only once the subscribe response is streaming, never
while the request is pending: a request waits on this state before it is
sent.

*Held by `sdk/wire/outage`, `sdk/wire/unauthenticated`, `sdk/wire/attach-gate`, `packages/http-transport/src/transport/__tests__/actor-state-unit.test.ts`.*

### Reconnect discipline

**After a drop** — the stream ended, or a connect was refused or failed:

- The client opens its stream again on an equal-jitter exponential
  backoff: a wait in [cap/2, cap], where cap is `reconnectMs` doubled per
  failure up to `maxReconnectMs`, and a successful open resets it. A
  refusal's `Retry-After` is a floor on the wait.
  *Held by `sdk/wire/outage`, `sdk/wire/stream-rate-limited`.*
- It sends each scope's `lastEventId` and the `pendingReplies` it still
  awaits.
  *Held by `sdk/wire/resumption`, `sdk/wire/pending-replies`.*
- A refused connect is reported on the error stream, with its status and
  code. A connection that failed without an answer is not: it is a state.
  *Held by `sdk/wire/stream-rate-limited`, `sdk/wire/outage`.*
- **A 401 is not retried.** The refused token is remembered and never sent
  again; the client is `unauthenticated` and checks, every `reconnectMs`
  and with no request, whether it has been given a different one. A client
  with a way to renew its token tries it once per outage before it waits.
  The same rule keeps a client with no token from sending a request at
  all.
  *Held by `sdk/wire/unauthenticated`, `packages/http-transport/src/transport/__tests__/actor-state-unit.test.ts`.*

**A changed subscription** — a scope taken or let go — is a **handoff**:

- The client opens a new stream with the changed matrix and, only once it
  is open, retires the old one. Nothing is missed, and the state stays
  `open`.
  *Held by `sdk/wire/subscribe-matrix`, `sdk/wire/passing-across-handoff`.*
- Additions are gathered for `reconnectDebounceMs`, so several arriving
  together are one handoff. A removal waits `lazyRemoveMs`: it only
  narrows what is delivered, and a client that brushes past scopes would
  otherwise reopen its stream at each.
  *Held by `sdk/wire/subscribe-matrix`.*
- A handoff whose connect fails is tried again, on the backoff, while the
  old stream stays live and the state stays `open`. The live stream ending
  while a handoff's connect is in flight is a drop, and that connect is
  its recovery.
  *Held by `packages/http-transport/src/transport/__tests__/actor-state-unit.test.ts`.*
- A client holds at most one live stream, one connecting, and one
  retiring, however fast its subscription changes: a principal's stream
  limit counts them.
  *Held by no case.*

### Abort discipline

Aborting a connection discards whatever it has received and not yet read.
So a connection is retired by **drain**, never by an abort at the moment
of handoff: the old stream keeps being read for `lingerMs` after the new
one opens, and is closed then. An abort is for a caller cancelling its own
request, and for teardown, where nobody remains to receive the bytes.

An event written to any live connection is delivered exactly once,
wherever a handoff or a reopening lands relative to it.

*Held by `sdk/wire/overlap-dedup`, `packages/http-transport/src/transport/__tests__/actor-liveness.property.test.ts`.*

### Delivering a frame once

While the old stream drains, both streams carry the same live frames, and
a new stream's replay can repeat what the old one already carried. The
client delivers a frame only if its id is not among the last
`seenEventIdsCount` it delivered.

- A positioned frame (`p-*`) is delivered once.
  *Held by `sdk/wire/dedup-window`.*
- A correlated frame (`e-<channel>:<correlationId>`) is delivered once.
  *Held by `sdk/wire/overlap-dedup`.*
- A passing frame has a different id on each connection, so its two copies
  are not recognised as one: a frame published while both streams are open
  is **delivered twice**.
  *Held by `sdk/wire/passing-across-handoff`.*

### Emitting

- An emit carries the client's `clientId`, and its `scope` and
  `correlationId` on the request's envelope, beside the payload.
  *Held by `sdk/wire/emit-counted`, `sdk/wire/request-reply`.*
- Each attempt has a deadline of `emitTimeoutMs`. An attempt refused by a
  limit (429), by a gateway that says it will recover (503, 504), or
  unanswered at its deadline is made again inside `emitRetry`, no sooner
  than a refusal's `Retry-After`; any other refusal is final
  ([`specs/src/retry/cases.json`](../../specs/src/retry/cases.json)).
  *Held by `sdk/wire/emit-rate-limited`, `sdk/wire/emit-budget-spent`, `sdk/wire/emit-refused`, `sdk/wire/unreachable`.*

## Wire framing and client parser obligations

The stream is plain `text/event-stream`. Each frame is written as:

```
event: bus-event
id: <its id>
data: <JSON {channel, correlationId?, payload, scope?}>
<blank line>
```

and the heartbeat as:

```
event: ping
data:
<blank line>
```

There is no compression and no chunked-JSON framing: `data:` is always
exactly one line, followed by one terminating blank line. A client ignores
an `event` it does not know.

**A parser holds its state across reads.** One frame can span many reads
of the connection (a reply carrying a resource and its annotations runs to
megabytes), and a read can end anywhere: inside a line, between a line and
its blank line, inside a character. A parser that resets per read drops
every frame that spans two.

*Held by `sdk/wire/chunked-stream`.*

## Channels and scope

A client subscribes globally to the channels every client hears and to an
operation's reply channels, and per resource to the channels a scope
carries. Both sets are the registry's `audience`, generated into
`BRIDGED_CHANNELS` and `RESOURCE_SCOPED_CHANNELS` (`@semiont/core`), and
they are disjoint: a channel in both would reach a client twice, under two
ids.

*Held by `packages/core/src/__tests__/bus-invariants.test.ts`.*

A client that awaits only some operations may name only their reply
channels in `global`. A request whose reply channels its stream does not
name fails at once (the contract's `unsubscribed`).

*Held by `sdk/wire/request-unsubscribed`.*

## Known gaps

### No channel-level authorization

Any authenticated principal who subscribes to a broadcast channel receives
everything on it; only correlated replies are routed to their requester.
A handler may enforce authorization in its own body, by reading `_userId`,
but `/bus/subscribe` does not filter. A real limitation for any deployment
with more than one tenant.

## Where the code lives

- `apps/gateway/src/routes/bus.rs`, `apps/gateway/src/routes/stream.rs` —
  the `/bus/emit` and `/bus/subscribe` routes.
- `specs/src/bus/registry.json` — the authority: channels, payloads,
  operations.
- `packages/http-transport/src/transport/http-transport.ts` — the
  reference client's `ITransport`.
- `packages/http-transport/src/transport/actor-state-unit.ts` — its
  stream: the reader, the reconnect and handoff logic, the subscription
  matrix.
- `packages/core/src/bus-request.ts` — `busRequest`.
- `packages/http-transport-rust/src/transport.rs` — the Rust client's
  `Transport`, and `actor.rs`, its stream.
- `packages/sdk-rust/src/bus.rs` — its bus request.
