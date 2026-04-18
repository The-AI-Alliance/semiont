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

- `POST /bus/emit` — `{ channel, payload, scope? }` → 202. Validates
  payload against `CHANNEL_SCHEMAS` (Ajv), injects `_userId`, emits on
  the (possibly scoped) EventBus.

- `GET /bus/subscribe?channel=X&channel=Y&scoped=Z&scope=res-123` —
  long-lived SSE.
  - `channel` params subscribe on the global EventBus (result channels,
    system-wide events like `mark:entity-type-added`).
  - `scoped` params subscribe on `eventBus.scope(scope)` — for
    resource-scoped domain events (`mark:added`, `yield:create-ok`, etc.).
  - Each SSE frame carries `event: bus-event` with data
    `{ channel, payload, scope? }`.

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
2. Add channels to the `EventMap` in `bus-protocol.ts`.
3. Add entries to `CHANNEL_SCHEMAS` in `bus.ts` so `/bus/emit`
   validates the payload.
4. Add a handler that subscribes to the request channel and emits on
   the result channel.
5. Add a method to the verb namespace that calls `busRequest()` for
   request-response or `actor.emit()` for fire-and-forget.

No new routes. No new SSE endpoint. No handshake.
