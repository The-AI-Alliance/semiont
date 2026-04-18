# Event Bridging: Backend Actors → Frontend

This document explains how events flow from backend actors (Stower,
Browser, Gatherer, Matcher, job handlers, workers) through the bus
gateway to the frontend, enabling real-time updates in the UI.

## Architecture Overview

```
┌─────────────────────┐
│ Backend actors      │
│ (Stower, Browser,   │
│  Gatherer, Matcher, │
│  job handlers)      │
│                     │
│  EventBus.next()    │
│  on channel         │
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ EventStore enriches │  (for persisted events)
│ annotation events   │
│ with view data      │
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ EventBus            │
│ (in-process RxJS)   │
│                     │
│ Global channels     │
│ Scoped channels     │
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ /bus/subscribe      │  Single SSE endpoint
│ (bus gateway)       │  relays subscribed channels
└──────────┬──────────┘
           │ HTTP SSE stream
           ↓
┌─────────────────────┐
│ Frontend ActorVM    │  One connection
│                     │  Bridges events into
│  on$(channel)       │  local EventBus
│  emit(channel, ...) │
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ Local EventBus      │
│                     │
│ BrowseNamespace     │  Cache invalidation
│ Flow VMs            │  Progress UI
│ React components    │
└─────────────────────┘
```

Workers (detection, generation) and the smelter are separate processes.
They are bus actors themselves — they use the same `ActorVM` primitive
as the frontend to subscribe to job channels and emit domain events via
`/bus/emit`. The bus gateway on the backend broadcasts these events on
the in-process EventBus, which the frontend picks up via its own
subscription.

## Event sources

### Routes

HTTP routes accept commands and emit on the EventBus. With
COLLAPSE-ROUTES done, most domain routes have been replaced by
`/bus/emit` — the route layer is now small (auth, admin, binary content,
health). Commands come via `/bus/emit` directly.

### Actors (make-meaning)

Registered in `startMakeMeaning()`. Each calls
`eventBus.get(channel).subscribe(handler)` during `initialize()`.
Channel-to-handler mapping is just pub/sub — no routing table.

- **Stower** — persists domain events. The only writer to the event
  store. Subscribes to `mark:create`, `mark:delete`, `mark:update-body`,
  `mark:archive`, `yield:create`, etc.
- **Browser** — answers read queries. Subscribes to
  `browse:*-requested` channels, emits `browse:*-result`.
- **Gatherer** — LLM context assembly. Subscribes to
  `gather:requested`, `gather:resource-requested`,
  `gather:summary-requested`.
- **Matcher** — semantic search. Subscribes to
  `match:search-requested`.
- **CloneTokenManager** — clone token workflow.

### Workers (separate processes)

Workers connect to `/bus/subscribe?channel=job:queued` via their own
ActorVM. On a matching job they emit `job:claim` (atomic CAS),
receive `job:claimed` with the full PendingJob, process it, and emit
domain events (`mark:progress`, `mark:create`, `job:complete`, etc.)
via `/bus/emit`.

## Enrichment at the publish site

`EventStore.appendEvent()` runs an enrichment callback after
materialization and before publishing on the EventBus. For annotation-
mutating events (`mark:added`, `mark:removed`, `mark:body-updated`),
the callback reads the post-materialization annotation from the view
and attaches it as an `annotation` field on the event.

Subscribers that don't care about the field (graph consumer, smelter)
ignore it. The frontend BrowseNamespace uses it to update cached
observables in-place without an HTTP refetch.

See [REAL-TIME.md](./REAL-TIME.md) for the enrichment callback setup.

## Resource scoping

The backend EventBus is scoped per resource (`eventBus.scope(resourceId)`).
When `EventStore.appendEvent` publishes a domain event for a specific
resource, it publishes on both the global bus and the resource-scoped
bus.

The bus gateway's `/bus/subscribe` endpoint accepts:

- `channel` query params — subscribe on the global bus
- `scoped` query params + `scope` — subscribe on a resource-scoped bus

The frontend uses both in a single connection: global for result
channels (`browse:*-result`, etc.), scoped for per-resource domain
events (`mark:added`, `yield:create-ok`, etc.).

## Frontend delivery

The frontend's `SemiontApiClient` creates one `ActorVM` lazily. The
ActorVM:

1. Connects to `/bus/subscribe` with all result channels at start.
2. When a resource page mounts, adds resource-scoped domain event
   channels via `addChannels()`. Removes them on unmount.
3. Bridges domain events into the local RxJS EventBus so
   BrowseNamespace cache invalidation subscriptions work unchanged.

Flow VMs (`mark-vm`, `gather-vm`, etc.) subscribe to the local
EventBus for progress events and bridge UI events to namespace
methods. The namespaces call `busRequest()` for request-response
commands or `actor.emit()` for fire-and-forget.

## correlationId

Every request-response command carries a client-generated
`correlationId` (UUID). Handlers echo it on the result event. The
frontend's `busRequest()` helper filters result channels by
correlationId to match responses to originating requests.

Other participants see the same events but with someone else's
correlationId — they still see the state change but don't match it
to a local pending operation.

## Gap detection

If the SSE connection drops and reconnects, events may have been
missed during the outage. The ActorVM auto-reconnects with exponential
backoff. BrowseNamespace subscribes to `actor.connected$` and
invalidates all active caches on any reconnect-after-disconnect. Live
queries refetch and state resyncs.

No server-side replay. No Last-Event-ID. Reconnect is gap-detectable
and the frontend refetches.

## Related Files

### Backend
- [src/routes/bus.ts](../src/routes/bus.ts) — `/bus/emit` and `/bus/subscribe`
- [packages/event-sourcing/src/event-store.ts](../../packages/event-sourcing/src/event-store.ts) — publish + enrich path
- [packages/make-meaning/src/service.ts](../../packages/make-meaning/src/service.ts) — actor wiring
- [packages/make-meaning/src/event-enrichment.ts](../../packages/make-meaning/src/event-enrichment.ts) — annotation enrichment

### Frontend
- [packages/api-client/src/view-models/domain/actor-vm.ts](../../packages/api-client/src/view-models/domain/actor-vm.ts) — the bus actor
- [packages/api-client/src/client.ts](../../packages/api-client/src/client.ts) — `SemiontApiClient.subscribeToResource()`
- [packages/api-client/src/namespaces/browse.ts](../../packages/api-client/src/namespaces/browse.ts) — cache invalidation + gap detection
- [packages/api-client/src/bus-request.ts](../../packages/api-client/src/bus-request.ts) — correlationId request-response

### Worker / Smelter
- [packages/api-client/src/view-models/domain/worker-vm.ts](../../packages/api-client/src/view-models/domain/worker-vm.ts)
- [packages/api-client/src/view-models/domain/smelter-actor-vm.ts](../../packages/api-client/src/view-models/domain/smelter-actor-vm.ts)
