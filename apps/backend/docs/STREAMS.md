# Bus Gateway Architecture

## How async operations work

Every async operation flows through a single bidirectional bus gateway:

```
Client                              Server
  │                                   │
  │  POST /bus/emit                  │
  │  { channel, payload, scope? }     │
  │ ──────────────────────────────►   │
  │                                   │  EventBus.next() on channel
  │                                   │  (authenticated user's DID
  │  ◄── 202                         │   injected as _userId)
  │                                   │
  │                                   │  handler (Stower, Browser,
  │                                   │  Gatherer, Matcher, Job...)
  │                                   │  processes command...
  │                                   │
  │  /bus/subscribe (long-lived SSE) │
  │  ◄── bus-event: browse:*-result  │
  │  ◄── bus-event: mark:progress    │
  │  ◄── bus-event: mark:added       │
  │  ◄── bus-event: yield:finished   │
  │                                   │
```

**Commands** POST to `/bus/emit`. Returns 202. The `/bus/emit` endpoint
validates the payload against a channel-specific OpenAPI schema, injects
`_userId` from the authenticated JWT, and pushes the event onto the
backend's in-process `EventBus`. Handlers that subscribed to the channel
pick it up.

**Results** arrive on `/bus/subscribe` — a single long-lived SSE
connection that every frontend opens on first bus use. Every channel
the client cares about is listed at connect time.

## The bus gateway

Two endpoints:

- `POST /bus/emit` — `{ channel, payload, scope? }` → 202. Rejects
  unknown channels. Validates payload against `CHANNEL_SCHEMAS` (from
  `@semiont/core`, Ajv-validated; `null` entries pass through),
  injects `_userId`, emits on the (possibly scoped) EventBus. The
  `scope` parameter is only meaningful for genuine resource-bound
  broadcasts — in practice only WorkerVM uses it (see "When to
  scope").

- `GET /bus/subscribe?channel=X&channel=Y&scoped=Z&scope=res-123` —
  long-lived SSE.
  - `channel` params subscribe on the global EventBus (result channels,
    system-wide events like `mark:entity-type-added`).
  - `scoped` params subscribe on `eventBus.scope(scope)` — for
    resource-scoped domain events (`mark:added`, `yield:create-ok`, etc.).
  - Each SSE frame carries `event: bus-event` with data
    `{ channel, payload, scope? }`.

## When to scope

Scope is a **broadcast-narrowing** mechanism for resource-bound events
— nothing more. It is not addressing (the channel name is). Every
event on the bus faces two independent questions: "who reacts to it?"
(channel) and "does it concern one resource, all resources, or none?"
(scope).

| Event kind | Scoped? | Why |
|---|---|---|
| Command (one handler) | **No** | No fan-out to narrow. Handler subscribes by channel name; that's sufficient. |
| Correlation-ID response (e.g. `mark:create-ok`) | **No** | Caller filters by `correlationId`. Scope adds nothing and would require the emitter to know which resource the caller is on. |
| Resource-bound broadcast (persisted domain events; actor progress meant for all viewers) | **Yes** | Many viewers, only some care. Scope narrows fan-out to viewers of that resource. |
| System-wide broadcast (`mark:entity-type-added`, `beckon:focus`) | **No** | Concerns everyone — not about a specific resource. |

Consequences:

- **All backend handlers subscribe on the global bus.** A command has
  one handler; where the user was standing when they issued it is
  irrelevant.
- **`EventStore.appendEvent` double-publishes** persisted domain
  events — global (for backend subsystems that want every event:
  graph materializer, smelter) plus scoped (for per-resource SSE
  delivery). System events (`resourceId === '__system__'`) publish
  global only.
- **Backend actors** (Gatherer, Matcher) publish **correlation-ID
  responses globally** (`match:search-results`, `gather:complete`,
  etc.). The caller filters by `correlationId`.
- **Workers** publish `RESOURCE_BROADCAST_TYPES` (currently
  `yield:progress`/`finished`/`failed` — genuine "everyone viewing
  this resource wants to see progress" events) on the scoped bus.
  Everything else they emit is global.
- **Frontend** never passes a `scope` to `actor.emit`. Commands go
  global; handlers live on the global bus.

This rule is enforced structurally: see `RESOURCE_BROADCAST_TYPES` in
`packages/core/src/bus-protocol.ts`, and the worker's `emitEvent`
logic in `packages/api-client/src/view-models/domain/worker-vm.ts`.

## Handlers subscribe directly

Handlers register themselves during `startMakeMeaning()`. Each calls
`eventBus.get(channel).subscribe(handler)` — there is no routing table.
The channel name IS the routing.

- **Stower** — write commands (`mark:create`, `mark:delete`,
  `mark:update-body`, `mark:archive`, `yield:create`, `yield:update`,
  `job:start`/`complete`/`fail`). Only actor that writes to the event
  store.
- **Browser** — read queries (`browse:*-requested`). Reads materialized
  views, emits `browse:*-result`.
- **Gatherer** — context assembly (`gather:requested`,
  `gather:resource-requested`, `gather:summary-requested`).
- **Matcher** — search (`match:search-requested`).
- **CloneTokenManager** — clone token flow (`yield:clone-*`).
- **Job command handler** — `job:create`/`job:claim` → PendingJob,
  atomic CAS.
- **Annotation lookup handler** — `browse:annotation-context-requested`,
  `gather:summary-requested`.
- **Annotation assembly handler** — `mark:create-request` assembles the
  W3C annotation from the raw intent using the injected `_userId`, then
  emits `mark:create`.

## Enrichment at the publish site

`EventStore.appendEvent()` persists → materializes views → enriches →
publishes. The `setEnrichEvent()` callback, wired up in make-meaning,
reads the post-materialization annotation from the view and attaches
it to annotation-mutating events (`mark:added`, `mark:removed`,
`mark:body-updated`) before they're broadcast on the EventBus.

Subscribers that don't care about the extra field (graph consumer,
smelter) ignore it. The frontend's BrowseNamespace reads it to update
its cache in-place without refetching.

## correlationId

Every request-response command carries a `correlationId` (UUID, client-
generated). Handlers echo it on the result event. The frontend's
`busRequest()` helper uses it to match result events back to the
originating emit.

## Frontend: one SSE connection

`SemiontApiClient` lazily creates one `ActorVM` on first bus use.
The ActorVM:

- Connects to `/bus/subscribe` with all result channels at start.
- Adds resource-scoped domain event channels via `addChannels()` when
  the resource-viewer-page-vm mounts. Removes them on unmount.
- Bridges domain events into the local RxJS EventBus so
  `BrowseNamespace` cache invalidation subscriptions keep working
  unchanged.
- On reconnect after a disconnect, BrowseNamespace invalidates all
  active caches (gap detection — anything missed during the outage
  gets refetched).

The CLI and MCP server use the same ActorVM primitive directly.
Workers and the Smelter are also bus actors with their own ActorVM
instances.

## Adding a new async operation

1. Define OpenAPI schemas for the request and result payloads.
2. Add channels to `EventMap` **and** `CHANNEL_SCHEMAS` in
   `packages/core/src/bus-protocol.ts` — the `satisfies Record<EventName, ...>`
   constraint forces you to do both. Use `null` for compound / void /
   branded payloads that have no single schema.
3. Decide scope per the "When to scope" table above. For a broadcast-
   style result, add the channel to `RESOURCE_BROADCAST_TYPES`.
4. Add a handler that subscribes to the request channel on the
   **global** bus and emits on the result channel (global for
   correlation-ID responses, scoped only for genuine broadcasts).
5. Add a method to the verb namespace that calls `busRequest()` for
   request-response or `actor.emit()` for fire-and-forget. Never pass
   a scope from the frontend.

No new routes. No new SSE endpoint. No handshake.
