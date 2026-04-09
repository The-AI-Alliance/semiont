# @semiont/event-sourcing

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+event-sourcing%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=event-sourcing)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=event-sourcing)
[![npm version](https://img.shields.io/npm/v/@semiont/event-sourcing.svg)](https://www.npmjs.com/package/@semiont/event-sourcing)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/event-sourcing.svg)](https://www.npmjs.com/package/@semiont/event-sourcing)
[![License](https://img.shields.io/npm/l/@semiont/event-sourcing.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Event sourcing infrastructure for the Semiont knowledge platform. Provides the persistence layer for the append-only event log, materialized views, and event-driven projections.

## Architecture

```
appendEvent(event)
  1. Persist to EventLog (JSONL files)
  2. Materialize views (resource descriptors, entity types)
  3. Publish StoredEvent to Core EventBus typed channels
```

The **EventStore** is the single write path. It coordinates three concerns:

- **EventLog** — Append-only persistence to sharded JSONL files under `.semiont/events/`. This is the source of truth.
- **ViewManager** — Materializes resource views and system projections from events. Supports both incremental updates on every append and a full `rebuildAll(eventLog)` for startup recovery.
- **Core EventBus** (`@semiont/core`) — Publishes `StoredEvent` to typed channels after persistence

Event publishing uses the Core EventBus from `@semiont/core`. There is no internal pub/sub system — all subscribers (GraphDBConsumer, Smelter, SSE routes) subscribe directly to typed channels on the Core EventBus.

The materialized views directory is **ephemeral by design** — see the [ViewManager / ViewMaterializer](#viewmanager--viewmaterializer) section for the rebuild model and how it relates to the graph and vector consumers.

## Installation

```bash
npm install @semiont/event-sourcing
```

## Quick Start

```typescript
import { createEventStore } from '@semiont/event-sourcing';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, resourceId, userId, CREATION_METHODS } from '@semiont/core';

const project = new SemiontProject('/path/to/project');
const eventBus = new EventBus();
const eventStore = createEventStore(project, eventBus, logger);

// Append an event — persists, materializes views, publishes to EventBus
const stored = await eventStore.appendEvent({
  type: 'yield:created',
  resourceId: resourceId('doc-123'),
  userId: userId('did:web:example.com:users:alice'),
  version: 1,
  payload: {
    name: 'My Document',
    format: 'text/markdown',
    contentChecksum: 'sha256:abc...',
    creationMethod: CREATION_METHODS.API,
  },
});

// stored.event    — the ResourceEvent
// stored.metadata — { sequenceNumber, prevEventHash, checksum }
```

## Components

### EventStore

Orchestration layer. `appendEvent()` is the only write method — it coordinates persistence, view materialization, and event publishing in sequence.

```typescript
import { createEventStore } from '@semiont/event-sourcing';

const eventStore = createEventStore(project, eventBus, logger);
```

The `coreEventBus` parameter is required. After persistence, `appendEvent` publishes the full `StoredEvent` to:
- The global typed channel (e.g., `eventBus.get('mark:added')`)
- The resource-scoped typed channel (e.g., `eventBus.scope(resourceId).get('mark:added')`)

### EventLog

Append-only event persistence to sharded JSONL files. Each resource gets its own event stream under `.semiont/events/<shard>/<resourceId>.jsonl`. System events go to `__system__.jsonl`.

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

Materializes JSON views from events. Resource views are projected to `<stateDir>/resources/<shard>/<resourceId>.json`. System views (entity types) are projected to `<stateDir>/projections/__system__/`. The storage-uri index lives at `<stateDir>/projections/storage-uri-index.json`.

The materializer processes events through a large switch statement that builds up resource descriptors, annotation collections, and system state. There are two paths into it:

**Live append path** — every `EventStore.appendEvent()` call materializes the event incrementally:
- Resource events → `views.materializeResource(rid, event, getAllEvents)` → updates the resource view file and the storage-uri index.
- System events (currently `mark:entity-type-added`) → `views.materializeSystem(eventType, payload)` → updates `entitytypes.json`.

**Startup rebuild path** — `views.rebuildAll(eventLog)` walks the entire event log once at process start and writes every view from scratch. Idempotent: existing view files are overwritten. This is the recovery mechanism for the materialized layer.

```typescript
// Called once during knowledge-base construction, before any HTTP request
await eventStore.views.rebuildAll(eventStore.log);
```

The two paths use the same materialization primitives, so replaying event 1..N via `rebuildAll` produces the same final state as the live path walking 1..N over time.

#### Why startup rebuild exists

The materialized views directory (`stateDir`) is **ephemeral by design** — it's safe to wipe (container recreation, `semiont destroy`, dev cleanup), and the event log under `.semiont/events/` is the single source of truth. `rebuildAll` is what makes "ephemeral" safe: any time `stateDir` goes empty, the next process start repopulates it from the event log.

This makes the views layer the third leg of a symmetric pattern: the three derived read models (graph, vectors, materialized views) each have exactly one explicit rebuild method called from one place at startup:

| Derived store | Rebuild method | Owned by |
|---|---|---|
| Graph (Neo4j) | `GraphDBConsumer.rebuildAll()` | `@semiont/make-meaning` |
| Vectors (Qdrant) | `Smelter.rebuildAll()` | `@semiont/make-meaning` |
| Materialized views | `ViewManager.rebuildAll(eventLog)` | `@semiont/event-sourcing` |

All three are called from `createKnowledgeBase` before the HTTP server begins accepting requests, so by the time any client can hit the API, all three derived stores are caught up to the event log.

`rebuildAll` accepts any object satisfying the `RebuildEventSource` structural type (`getEvents(rid)` + `getAllResourceIds()`); the concrete `EventLog` satisfies it without an explicit conformance declaration.

### EventValidator

Verifies event chain integrity using cryptographic checksums.

```typescript
import { EventValidator } from '@semiont/event-sourcing';

const validator = new EventValidator();
const result = validator.validateChain(events);
// { valid: boolean, errors: string[] }
```

### Storage

- **EventStorage** — Low-level JSONL file I/O with sharding (jump-consistent hash)
- **FilesystemViewStorage** — JSON view persistence implementing the `ViewStorage` interface
- **Storage URI Index** — Maps `file://` URIs to resource IDs for filesystem-based resources

## Event Types

All persisted events use flow verb names (see `ResourceEvent` in `@semiont/core`):

| Event Type | Flow | Description |
|---|---|---|
| `yield:created` | Yield | Resource created |
| `yield:updated` | Yield | Resource content updated |
| `yield:moved` | Yield | Resource file moved |
| `yield:representation-added` | Yield | Multi-format representation added |
| `mark:added` | Mark | Annotation created |
| `mark:removed` | Mark | Annotation deleted |
| `mark:body-updated` | Mark | Annotation body modified |
| `mark:archived` | Mark | Resource archived |
| `mark:unarchived` | Mark | Resource unarchived |
| `mark:entity-tag-added` | Mark | Entity type tag added to resource |
| `mark:entity-tag-removed` | Mark | Entity type tag removed from resource |
| `mark:entity-type-added` | Mark | New entity type added (system-level) |
| `job:started` | Job | Background job started |
| `job:progress` | Job | Background job progress update |
| `job:completed` | Job | Background job completed |
| `job:failed` | Job | Background job failed |
| `embedding:computed` | Embedding | Vector embedding computed |
| `embedding:deleted` | Embedding | Vector embedding deleted |

## Exports

```typescript
// Core
export { EventStore, createEventStore, EventLog, ViewManager };

// Storage
export { EventStorage, FilesystemViewStorage, type ViewStorage, type ResourceView };
export { getShardPath, sha256, jumpConsistentHash };
export { resolveStorageUri, writeStorageUriEntry, removeStorageUriEntry };

// Query & Validation
export { EventQuery, EventValidator };

// Views
export { ViewMaterializer };

// Utilities
export { generateAnnotationId };
```
