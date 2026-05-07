# Channel Inventory

The set of channels every Semiont actor speaks, grouped by category. The protocol semantics behind these categories — naming, payload shape, scoping rules, persistence — are in **[EVENT-BUS.md](./EVENT-BUS.md)**. This doc is the reference list.

The authoritative TypeScript source is **[`packages/core/src/bus-protocol.ts`](../../packages/core/src/bus-protocol.ts)** — the `EventMap` type and the `CHANNEL_SCHEMAS` map. If a channel here disagrees with that file, the file wins.

## Persisted domain events (the system of record)

Past-tense `-ed` channels appended to the event store. These drive materialized views and replay. Subscribed via SSE `scoped` channels for resource-bound delivery; published on both the global bus and the resource-scoped bus by `EventStore.appendEvent`.

- `mark:added`, `mark:removed`, `mark:body-updated`
- `mark:archived`, `mark:unarchived`
- `mark:entity-tag-added`, `mark:entity-tag-removed`
- `yield:created`, `yield:cloned`, `yield:updated`, `yield:moved`
- `yield:representation-added`, `yield:representation-removed`
- `job:started`, `job:progress`, `job:completed`, `job:failed`

The authoritative list is `PERSISTED_EVENT_TYPES` in [`packages/core/src/persisted-events.ts`](../../packages/core/src/persisted-events.ts). The typecheck enforces that every `StoredEvent`-typed entry in `EventMap` is in this list.

## System-wide broadcasts

Persisted but not resource-scoped — concern every connected client.

- `frame:entity-type-added`

## Ephemeral cross-participant signals

Attention-coordination channels broadcast globally, not persisted. Delivered to every connected browser; the originator's emit echoes back through the bus so their UI responds too.

- `beckon:focus` — directs a participant to scroll/pulse an annotation
- `beckon:sparkle` — triggers a sparkle animation on an annotation

## Correlation-ID responses

Non-persisted results matched back to the originating request by `correlationId`. Always published on the **global** bus; the caller filters by its own `correlationId`. SDK consumers use `busRequest` ([`packages/sdk/src/bus-request.ts`](../../packages/sdk/src/bus-request.ts)) which hides the correlation glue.

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

## Resource-bound broadcasts

Channels every viewer of a specific resource wants to see, regardless of who triggered them. Published on `eventBus.scope(resourceId)`; received via `scope=rId&scoped=X` SSE subscription wired up by `client.subscribeToResource()`.

The authoritative list is `RESOURCE_BROADCAST_TYPES` in [`packages/core/src/bus-protocol.ts`](../../packages/core/src/bus-protocol.ts):

- `yield:progress`, `yield:finished`, `yield:failed`

## Bridged channels (HTTP transport fan-in)

The set the HTTP transport pushes onto the client's local bus on SSE receive. Includes every `-ok`, `-failed`, `-result`, plus the persisted domain events that drive cache invalidation. Authoritative list: `BRIDGED_CHANNELS` in [`packages/core/src/bridged-channels.ts`](../../packages/core/src/bridged-channels.ts).

In-process transports do the same fan-in via `LocalTransport.bridgeInto(bus)`.

## See also

- **[EVENT-BUS.md](./EVENT-BUS.md)** — channel naming, payload categories, scoping rules, `correlationId` / `_userId` / `_trace` conventions
- **[TRANSPORT-CONTRACT.md](./TRANSPORT-CONTRACT.md)** — abstract `ITransport` behavioral guarantees
- **[TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md)** — HTTP+SSE wire format
- **[`packages/core/src/bus-protocol.ts`](../../packages/core/src/bus-protocol.ts)** — `EventMap` and `CHANNEL_SCHEMAS`
- **[`packages/core/src/persisted-events.ts`](../../packages/core/src/persisted-events.ts)** — `PERSISTED_EVENT_TYPES`
- **[`packages/core/src/bridged-channels.ts`](../../packages/core/src/bridged-channels.ts)** — `BRIDGED_CHANNELS`
