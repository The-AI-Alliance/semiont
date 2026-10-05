# Event Sourcing API Reference

## The write path

```
appendEvent(event, options?)
  1. Persist to EventLog (JSONL files)
  2. Materialize views (resource descriptors, entity types)
  3. Publish StoredEvent to Core EventBus typed channels

options.correlationId rides the bus envelope of the publish in step 3, so a
caller can match the published event to the command that caused it. It is
never written to the log. See docs/protocol/EVENT-BUS.md.
```

The **EventStore** is the single write path. It coordinates three concerns:

- **EventLog** — Append-only persistence to sharded JSONL files under `.semiont/events/`. This is the source of truth.
- **ViewManager** — Materializes resource views and system projections from events. Supports both incremental updates on every append and a full `rebuildAll(eventLog)` for startup recovery.
- **Core EventBus** (`@semiont/core`) — Publishes `StoredEvent` to typed channels after persistence

Event publishing uses the Core EventBus from `@semiont/core`. There is no internal pub/sub system — subscribers in the same process subscribe directly to typed channels on the Core EventBus, and the Archivist republishes each persisted event onto the gateway's bus, where the Weaver, the Smelter and connected clients follow it.

The materialized views directory is **ephemeral by design** — see [ViewManager / ViewMaterializer](#viewmanager--viewmaterializer) for the rebuild model and how it relates to the graph and vector consumers.

## Components

### EventStore

Orchestration layer. `appendEvent()` is the only write method — it coordinates persistence, view materialization, and event publishing in sequence.

```typescript
import { createEventStore } from '@semiont/event-sourcing';

const eventStore = createEventStore(project, eventBus, logger);
```

The `eventBus` parameter is required. After persistence, `appendEvent` publishes the full `StoredEvent` to:
- The global typed channel (e.g., `eventBus.on('mark:added')`)
- The resource-scoped typed channel (e.g., `eventBus.scope(resourceId).on('mark:added')`)

### EventLog

Append-only event persistence to sharded JSONL files. Each resource gets its own event stream directory under `.semiont/events/<ab>/<cd>/<resourceId>/`, holding `events-NNNNNN.jsonl` files rotated every 10,000 events. System events go to `.semiont/events/__system__/`. Integrity is provided by git at the commit level (when `gitSync` is enabled) — there is no per-event hash chain. See [docs/STORAGE-LAYOUT.md](STORAGE-LAYOUT.md).

```typescript
// Append (used internally by EventStore)
const stored = await eventStore.log.append(event, resourceId);

// Read all events for a resource
const events = await eventStore.log.getEvents(resourceId);

// List all resource IDs
const ids = await eventStore.log.getAllResourceIds();
```

### EventQuery

Read-only query interface with filtering support.

```typescript
import { EventQuery } from '@semiont/event-sourcing';

const query = new EventQuery(eventStore.log.storage);

// Get all events for a resource
const events = await query.getResourceEvents(resourceId);

// Query with filters
const filtered = await query.queryEvents({
  resourceId,
  eventTypes: ['mark:added', 'mark:removed'],
  limit: 50,
});
```

### ViewManager / ViewMaterializer

Materializes JSON views from events. Resource views are projected to `<stateDir>/resources/<ab>/<cd>/<resourceId>.json`. System views (entity types, tag schemas, people) are projected to `<stateDir>/projections/__system__/`. The storage-uri index is sharded under `<stateDir>/projections/storage-uri/`.

The materializer processes events through a large switch statement that builds up resource descriptors, annotation collections, and system state. There are two paths into it:

**Live append path** — every `EventStore.appendEvent()` call materializes the event incrementally:
- Resource events → `views.materializeResource(rid, event, getAllEvents)` → updates the resource view file and the storage-uri index.
- System events (`frame:entity-type-added`, `frame:tag-schema-added`, `person:profiled`) → `views.materializeSystem(event)` → updates `entitytypes.json` / `tagschemas.json` / `people.json`.

**Startup rebuild path** — `views.rebuildAll(eventLog)` walks the entire event log once at process start and writes every view from scratch. Idempotent: existing view files are overwritten. This is the recovery mechanism for the materialized layer.

```typescript
// Called once during knowledge-base construction, before any HTTP request
await eventStore.views.rebuildAll(eventStore.log);
```

The two paths use the same materialization primitives, so replaying event 1..N via `rebuildAll` produces the same final state as the live path walking 1..N over time.

#### Pure projection reducers

The `__system__` projections (`entitytypes.json`, `tagschemas.json`, `people.json`) are written by a thin I/O shell wrapping pure functions that own the merge/dedup/sort/conflict semantics. The pure reducers live in [`src/views/projection-reducers.ts`](../src/views/projection-reducers.ts):

- `applyEntityTypeAdded(view, tag)` → `string[]` — dedup + locale-aware sort.
- `applyTagSchemaAdded(view, schema)` → `{ next; warning? }` — most-recent-wins by id, warning on overwrite-with-different-content.
- `applyPersonProfiled(view, did, name, since)` → `PeopleView` — last-wins per DID.

The shell methods on `ViewMaterializer` (`materializeEntityTypes`, `materializeTagSchemas`, `materializePeople`) read the projection file, call the reducer, then write the result. The semantics are the reducer's; the disk I/O is the shell's.

This split keeps projection-update tests pure (single-digit milliseconds, no filesystem) and gives load-bearing invariants — sortedness, uniqueness, idempotence, most-recent-wins — a property-based-test home using fast-check. The full architectural narrative, the axiom catalog, and guidance for adding new projections lives in [`docs/architecture/PROJECTION-PATTERN.md`](../../../docs/architecture/PROJECTION-PATTERN.md).

#### Why startup rebuild exists

The materialized views directory (`stateDir`) is **ephemeral by design** — it's safe to wipe (`semiont clean`, dev cleanup), and the event log under `.semiont/events/` is the single source of truth. `rebuildAll` is what makes "ephemeral" safe: any time `stateDir` goes empty, the next process start repopulates it from the event log.

This makes the views layer the third leg of a symmetric pattern: the three derived read models (graph, vectors, materialized views) each have exactly one owner, which recovers its store from the record at startup:

| Derived store | Startup recovery | Owned by |
|---|---|---|
| Graph (Neo4j) | `Weaver.catchUp()`, from its checkpoint | `@semiont/make-meaning` |
| Vectors (Qdrant) | `Smelter.reconcile()`, against the catalog | `@semiont/make-meaning` |
| Materialized views | `ViewManager.rebuildAll(eventLog)` | `@semiont/event-sourcing` |

Each runs in its own service: the Archivist calls `rebuildAll` before it serves a request, the Weaver catches up in `weaver-main`, and the Smelter reconciles in `smelter-main`. `createKnowledgeBase` calls `rebuildAll` the same way for an in-process composition.

`rebuildAll` accepts any object satisfying the `RebuildEventSource` structural type (`getEvents(rid)` + `getAllResourceIds()`); the concrete `EventLog` satisfies it without an explicit conformance declaration.

### Storage

- **EventStorage** — Low-level JSONL file I/O with 4-hex hash sharding and file rotation
- **FilesystemViewStorage** — JSON view persistence implementing the `ViewStorage` interface
- **Storage URI Index** — Maps `file://` URIs to resource IDs for filesystem-based resources

## Event types

The events a knowledge base records are [`@semiont/core`](../../core/README.md)'s `PersistedEvent` catalogue, generated from the bus registry. `PERSISTED_EVENT_TYPES` is the list at run time.
