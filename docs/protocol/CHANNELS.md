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

Non-persisted results matched back to the originating request by `correlationId`. Always published on the **global** bus; the caller filters by its own `correlationId`. Consumers use `busRequest` ([`packages/core/src/bus-request.ts`](../../packages/core/src/bus-request.ts)), which hides the correlation glue and looks up the result/failure channels from `BUS_OPERATIONS`. Every reply follows the standard shape: `{ correlationId, response: T }` (data), `{ correlationId }` (void), or `{ correlationId } & CommandError` (failure).

- `browse:*-result` / `browse:*-failed`
- `mark:*-ok` / `mark:*-failed`
- `bind:body-update-failed`
- `match:search-results` / `match:search-failed`
- `gather:complete` / `gather:failed` / `gather:annotation-progress`
- `gather:summary-result` / `gather:summary-failed`
- `job:created` / `job:create-failed` / `job:claimed` / `job:claim-failed`
- `job:complete` / `job:fail` — global job-lifecycle signals; the dispatching caller filters by `jobId`, resource viewers filter the same global stream by `resourceId` (keyed by id, not `correlationId`)
- `yield:clone-token-generated` / `yield:clone-token-failed`
- `yield:clone-resource-result` / `yield:clone-resource-failed`

## Resource-bound broadcasts

Channels every viewer of a specific resource wants to see, regardless of who triggered them. Published on `eventBus.scope(resourceId)`; received via a `scope=rId&scoped=X` SSE subscription the SDK wires up automatically when a consumer subscribes to that resource's `browse.*` live queries (freshness follows observation; #847).

The authoritative list is `RESOURCE_BROADCAST_TYPES` in [`packages/core/src/bus-protocol.ts`](../../packages/core/src/bus-protocol.ts) — **currently empty.** `job:complete` / `job:fail` used to live here but were moved to global, `jobId`-keyed delivery (see *Correlation-ID responses* above, and #847): the dispatcher filters by `jobId`, viewers filter the global stream by `resourceId`, so a client that is both no longer receives them twice. The set remains as the extension point for genuine multi-viewer resource broadcasts (e.g. generation progress).

## Bridged channels (HTTP transport fan-in)

The set the HTTP transport pushes onto the client's local bus on SSE receive: every operation's reply channels (`-ok` / `-failed` / `-result` / progress) plus the system-wide broadcasts. `BRIDGED_CHANNELS` ([`packages/core/src/bridged-channels.ts`](../../packages/core/src/bridged-channels.ts)) is **derived**, not hand-maintained — the reply channels come from the `BUS_OPERATIONS` registry, plus a small `BRIDGED_BROADCASTS` hand-list for the non-request/reply minority (KB-global domain events, `beckon:*` UI signals, infra). Deriving the reply set is what keeps a reply channel from being silently omitted. Bridged channels are delivered globally and are **disjoint** from the resource-scoped set (see [TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md)).

In-process transports do the same fan-in via `LocalTransport.bridgeInto(bus)`.

## See also

- **[EVENT-BUS.md](./EVENT-BUS.md)** — channel naming, payload categories, scoping rules, `correlationId` / `_userId` / `_trace` conventions
- **[TRANSPORT-CONTRACT.md](./TRANSPORT-CONTRACT.md)** — abstract `ITransport` behavioral guarantees
- **[TRANSPORT-HTTP.md](./TRANSPORT-HTTP.md)** — HTTP+SSE wire format
- **[`packages/core/src/bus-protocol.ts`](../../packages/core/src/bus-protocol.ts)** — `EventMap` and `CHANNEL_SCHEMAS`
- **[`packages/core/src/persisted-events.ts`](../../packages/core/src/persisted-events.ts)** — `PERSISTED_EVENT_TYPES`
- **[`packages/core/src/bridged-channels.ts`](../../packages/core/src/bridged-channels.ts)** — `BRIDGED_CHANNELS`
