# Real-Time Event Delivery

**Purpose**: Bus gateway architecture for delivering real-time updates
from the backend EventBus to frontend subscribers over a single
Server-Sent Events (SSE) connection.

**Related Documentation**:
- [Bus Gateway Architecture](./STREAMS.md) — the bus model end-to-end
- [W3C Web Annotation Implementation](./W3C-WEB-ANNOTATION.md) — event
  store and event sourcing

## Overview

Every domain operation (commands and queries) flows through the bus
gateway. The frontend opens one SSE connection to `/bus/subscribe` and
posts commands to `/bus/emit`. The same mechanism serves request-
response results, progress events, and real-time domain updates.

## Architecture

```
Frontend (browser)                     Backend
  │                                        │
  │                                    Route / Handler
  │   POST /bus/emit                        │
  │   { channel, payload, scope? }          │
  │ ─────────────────────────────────►      │
  │                                    /bus/emit injects _userId,
  │                                    validates payload, calls
  │                                    eventBus.get(channel).next()
  │                                        │
  │                                    Handler (Stower / Browser / ...)
  │                                    persists + materializes + enriches
  │                                    EventStore publishes on scoped bus
  │                                        │
  │   GET /bus/subscribe (one SSE)          │
  │   ?channel=X&scoped=Y&scope=res-123     │
  │   ◄── bus-event                         │
  │                                        │
  ActorVM.on$(channel) observers
  BrowseNamespace cache invalidation
  Flow VM progress UI updates
```

## When scope matters

Scope is a broadcast-narrowing filter, not addressing. See the "When
to scope" section of [STREAMS.md](./STREAMS.md) for the full rule.
Short version for SSE delivery:

- Global channels (`channel=X`) carry commands' correlation-ID
  responses, system-wide signals (`mark:entity-type-added`,
  `beckon:*`), and everything the backend publishes un-scoped.
- Scoped channels (`scope=rId&scoped=Y`) carry persisted domain
  events for resource `rId` (via `EventStore`'s dual publish) and
  the curated list of genuine resource-wide broadcasts
  (`RESOURCE_BROADCAST_TYPES` — today just `yield:progress/finished/
  failed`).

Callers never need to subscribe to a scope to receive the result of
their own request — correlation-ID responses are always global.

## Single SSE connection

`SemiontApiClient` creates one `ActorVM` lazily on first bus use. The
ActorVM opens `GET /bus/subscribe` with a list of channels:

- **Global channels** via `channel=X` query params — result/failure
  channels (`browse:*-result`, `mark:*-ok`, `job:created`, etc.) and
  system-wide events (`mark:entity-type-added`).
- **Resource-scoped channels** via `scoped=X` query params combined
  with `scope=resourceId` — per-resource domain events (`mark:added`,
  `yield:create-ok`, `mark:body-updated`, etc.).

When the resource-viewer-page-vm mounts, it calls
`client.subscribeToResource(resourceId)` which calls
`actor.addChannels([...RESOURCE_SCOPED_CHANNELS], resourceId)`. The
ActorVM reconnects with the updated channel list. On unmount, the
channels are removed and the ActorVM reconnects without them.

## Enrichment at the publish site

Annotation-mutating events are decorated with the post-materialization
annotation inside the event store publish path.
Now enrichment happens inside `EventStore.appendEvent()` via a
callback:

```typescript
eventStore.setEnrichEvent(async (event, resourceId) => {
  const annId = eventAnnotationId(event);
  if (annId === null) return event;
  const annotation = await readAnnotationFromView(kb, resourceId, annId);
  if (annotation === null) return event;
  return { ...event, annotation };
});
```

Events that mutate annotations (`mark:added`, `mark:removed`,
`mark:body-updated`) carry the post-materialization annotation as an
extra field. Subscribers that don't care about the field (graph
consumer, smelter) ignore it.

## Gap detection on reconnect

If the ActorVM's SSE connection drops and reconnects, the frontend
can't tell which events were missed during the outage. BrowseNamespace
handles this by subscribing to `actor.connected$` and invalidating all
active caches on any reconnect after a disconnect. Live queries
refetch and the UI re-syncs.

No server-side replay. No Last-Event-ID. Just refetch.

## Event types

### Persisted domain events (from `EventStore.appendEvent`)

The source-of-truth events, subscribed to via `scoped` channels:

- `mark:added`, `mark:removed`, `mark:body-updated`
- `mark:archived`, `mark:unarchived`
- `mark:entity-tag-added`, `mark:entity-tag-removed`
- `yield:created`, `yield:cloned`, `yield:updated`, `yield:moved`
- `yield:representation-added`, `yield:representation-removed`
- `job:started`, `job:progress`, `job:completed`, `job:failed`

System-wide (not resource-scoped):
- `mark:entity-type-added`

### Ephemeral cross-participant signals

Attention coordination signals, broadcast globally (not persisted):

- `beckon:focus` — directs a participant to scroll/pulse an annotation
- `beckon:sparkle` — triggers a sparkle animation on an annotation

Delivered to every connected browser. The originator's own emit echoes
back through the bus, so their UI responds too — intentional for
`client.beckon.attention()`-style programmatic calls.

### Correlation-ID responses (global, from handlers and actors)

Non-persisted results matched back to their originating request by
`correlationId`. Published on the **global** bus, received via the
`channel=X` SSE subscription. The caller — whether UI, CLI, MCP, or
worker — filters by its own `correlationId`.

- `browse:*-result` / `browse:*-failed`
- `mark:*-ok` / `mark:*-failed`
- `bind:body-update-failed`
- `match:search-results` / `match:search-failed`
- `gather:complete` / `gather:failed` / `gather:annotation-progress`
- `gather:summary-result` / `gather:summary-failed`
- `mark:progress` / `mark:assist-finished` / `mark:assist-failed`
- `job:created` / `job:create-failed` / `job:claimed` / `job:claim-failed`
- `yield:clone-token-generated` / `yield:clone-token-failed`
- `yield:clone-resource-result` / `yield:clone-resource-failed`

### Resource-bound broadcasts (scoped)

Events a participant wants to see because they're viewing a specific
resource, regardless of who triggered them. Published on
`eventBus.scope(resourceId)`. Received via `scope=rId&scoped=X`
subscription, which `subscribeToResource()` wires up. Constant:
`RESOURCE_BROADCAST_TYPES` in `packages/core/src/bus-protocol.ts`.

- `yield:progress`, `yield:finished`, `yield:failed`

## Debugging

### Frontend

Open DevTools → Network tab. Filter by `subscribe`. The
`/bus/subscribe` request stays pending — its EventStream tab shows
every `bus-event` as it arrives.

### Backend

Filter logs by `component: 'bus'`:

```bash
tail -f apps/backend/logs/app.log | jq 'select(.component=="bus")'
```

On emit failures (payload validation), look for
`Bus emit validation failed` with the channel name and error message.

## Related Files

### Backend
- [src/routes/bus.ts](../src/routes/bus.ts) — `/bus/emit` and `/bus/subscribe`
- [src/handlers/](../src/handlers/) — bus command handlers
- [packages/event-sourcing/src/event-store.ts](../../packages/event-sourcing/src/event-store.ts) — enrichment callback
- [packages/make-meaning/src/event-enrichment.ts](../../packages/make-meaning/src/event-enrichment.ts) — annotation enrichment

### Frontend
- [packages/api-client/src/view-models/domain/actor-vm.ts](../../packages/api-client/src/view-models/domain/actor-vm.ts) — the bus actor
- [packages/api-client/src/bus-request.ts](../../packages/api-client/src/bus-request.ts) — correlationId request-response helper
- [packages/api-client/src/client.ts](../../packages/api-client/src/client.ts) — `SemiontApiClient.subscribeToResource()`
- [packages/api-client/src/namespaces/browse.ts](../../packages/api-client/src/namespaces/browse.ts) — cache invalidation + gap detection

