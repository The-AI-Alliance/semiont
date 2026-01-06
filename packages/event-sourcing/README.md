# @semiont/event-sourcing

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml)
[![npm version](https://img.shields.io/npm/v/@semiont/event-sourcing.svg)](https://www.npmjs.com/package/@semiont/event-sourcing)
[![License](https://img.shields.io/npm/l/@semiont/event-sourcing.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Event sourcing infrastructure for [Semiont](https://github.com/The-AI-Alliance/semiont) - provides event persistence, pub/sub, and materialized views for building event-driven applications.

## What is Event Sourcing?

Event sourcing is a pattern where state changes are stored as a sequence of immutable events. Instead of storing current state, you store the history of events that led to the current state.

**Benefits:**
- **Complete audit trail** - Every change is recorded with timestamp and user
- **Time travel** - Rebuild state at any point in history
- **Event replay** - Reprocess events to rebuild views or fix bugs
- **Microservices-ready** - Events enable distributed systems to stay in sync

## Installation

```bash
npm install @semiont/event-sourcing
```

**Prerequisites:**
- Node.js >= 20.18.1
- `@semiont/core` and `@semiont/api-client` (peer dependencies)

## Quick Start

```typescript
import {
  EventStore,
  FilesystemViewStorage,
  type IdentifierConfig,
} from '@semiont/event-sourcing';
import { resourceId, userId } from '@semiont/core';

// 1. Create event store
const eventStore = new EventStore(
  {
    basePath: './data',
    dataDir: './data/events',
    enableSharding: true,
    maxEventsPerFile: 10000,
  },
  new FilesystemViewStorage('./data'),
  { baseUrl: 'http://localhost:4000' }
);

// 2. Append events
const event = await eventStore.appendEvent({
  type: 'resource.created',
  resourceId: resourceId('doc-abc123'),
  userId: userId('user@example.com'),
  payload: {
    name: 'My Document',
    format: 'text/plain',
    contentChecksum: 'sha256:...',
    entityTypes: [],
  },
});

// 3. Subscribe to events
eventStore.bus.subscribe(
  resourceId('doc-abc123'),
  async (storedEvent) => {
    console.log('Event received:', storedEvent.event.type);
  }
);

// 4. Query events
const events = await eventStore.log.queryEvents(
  resourceId('doc-abc123'),
  { eventTypes: ['resource.created', 'annotation.added'] }
);
```

## Architecture

The event-sourcing package follows a layered architecture with clear separation of concerns:

```
┌─────────────────────────────────────────┐
│          EventStore                     │  ← Orchestration
│  (coordinates log, bus, views)          │
└─────────────────────────────────────────┘
         │              │              │
    ┌────┘         ┌────┘         └────┐
    ▼              ▼                   ▼
┌────────┐    ┌──────────┐    ┌──────────────┐
│EventLog│    │ EventBus │    │ ViewManager  │
│(persist)    │ (pub/sub)│    │ (materialize)│
└────────┘    └──────────┘    └──────────────┘
    │              │                   │
    ▼              ▼                   ▼
┌──────────┐  ┌──────────────┐  ┌─────────────┐
│EventStorage EventSubscriptions ViewStorage  │
│(JSONL files)  (in-memory)     (JSON files) │
└──────────┘  └──────────────┘  └─────────────┘
```

**Key Components:**

- **EventStore** - Orchestration layer that coordinates event operations
- **EventLog** - Append-only event persistence with JSONL storage
- **EventBus** - Pub/sub notifications for real-time event processing
- **ViewManager** - Materialized view updates from event streams
- **EventStorage** - Filesystem storage with sharding for scalability
- **ViewStorage** - Materialized view persistence (current state)

## Core Concepts

### Events

Events are immutable records of state changes:

```typescript
import type { ResourceEvent, StoredEvent } from '@semiont/core';

// Event to append (before storage)
const event: Omit<ResourceEvent, 'id' | 'timestamp'> = {
  type: 'resource.created',
  resourceId: resourceId('doc-123'),
  userId: userId('user@example.com'),
  payload: { /* event-specific data */ },
};

// Stored event (after persistence)
const stored: StoredEvent = {
  event: {
    id: eventId('evt-456'),
    timestamp: '2024-01-01T00:00:00Z',
    ...event,
  },
  metadata: {
    sequenceNumber: 1,
    checksum: 'sha256:...',
    version: '1.0',
  },
};
```

### Event Types

Semiont uses a hierarchical event type system:

- `resource.created` - New resource created
- `resource.cloned` - Resource cloned from another
- `resource.archived` / `resource.unarchived` - Archive status changed
- `annotation.added` / `annotation.deleted` - Annotations modified
- `annotation.body.updated` - Annotation body changed
- `entitytag.added` / `entitytag.removed` - Entity type tags modified
- `entitytype.added` - New entity type registered (system-level)

### Materialized Views

Views are projections of event streams into queryable state:

```typescript
import type { ResourceView } from '@semiont/event-sourcing';

// A view contains both metadata and annotations
const view: ResourceView = {
  resource: {
    '@id': 'http://localhost:4000/resources/doc-123',
    name: 'My Document',
    representations: [/* ... */],
    entityTypes: ['Person', 'Organization'],
  },
  annotations: {
    annotations: [/* ... */],
  },
};
```

Views are automatically updated when events are appended.

## Documentation

📚 **[Event Store Guide](./docs/EventStore.md)** - EventStore API and orchestration

📖 **[Event Log Guide](./docs/EventLog.md)** - Event persistence and storage

🔔 **[Event Bus Guide](./docs/EventBus.md)** - Pub/sub and subscriptions

🔍 **[Views Guide](./docs/Views.md)** - Materialized views and projections

⚙️ **[Configuration Guide](./docs/Configuration.md)** - Setup and options

## Key Features

- **Type-safe** - Full TypeScript support with branded types from `@semiont/core`
- **Filesystem-based** - No external database required (JSONL for events, JSON for views)
- **Sharded storage** - Automatic sharding for scalability (65,536 shards using Jump Consistent Hash)
- **Real-time** - Pub/sub subscriptions for live event processing
- **Event replay** - Rebuild views from event history at any time
- **Framework-agnostic** - Pure TypeScript, no web framework dependencies

## Use Cases

✅ **CLI tools** - Build offline tools that use event sourcing without the full backend

✅ **Worker processes** - Separate microservices that process events independently

✅ **Testing** - Isolated event stores for unit/integration tests

✅ **Analytics** - Process event streams for metrics and insights

✅ **Audit systems** - Complete history of all changes with provenance

❌ **Not for frontend** - Use `@semiont/react-ui` hooks for frontend applications

## API Overview

### EventStore

```typescript
const store = new EventStore(storageConfig, viewStorage, identifierConfig);

// Append event (coordinates persistence → view → notification)
const stored = await store.appendEvent(event);

// Access components
store.log      // EventLog - persistence
store.bus      // EventBus - pub/sub
store.views    // ViewManager - views
```

### EventLog

```typescript
// Append event to log
const stored = await eventLog.append(event, resourceId);

// Get all events for resource
const events = await eventLog.getEvents(resourceId);

// Query with filter
const filtered = await eventLog.queryEvents(resourceId, {
  eventTypes: ['annotation.added'],
  fromSequence: 10,
});
```

### EventBus

```typescript
// Subscribe to resource events
const sub = eventBus.subscribe(resourceId, async (event) => {
  console.log('Event:', event.event.type);
});

// Subscribe to all system events
const globalSub = eventBus.subscribeGlobal(async (event) => {
  console.log('System event:', event.event.type);
});

// Unsubscribe
sub.unsubscribe();
```

### ViewManager

```typescript
// Materialize resource view from events
await viewManager.materializeResource(
  resourceId,
  event,
  () => eventLog.getEvents(resourceId)
);

// Get materialized view
const view = await viewStorage.get(resourceId);
```

## Storage Format

### Events (JSONL)

Events are stored in append-only JSONL files with sharding:

```
data/
  events/
    ab/                    # Shard level 1 (256 directories)
      cd/                  # Shard level 2 (256 subdirectories)
        doc-abc123.jsonl   # Event log for resource
```

Each line in the JSONL file is a complete `StoredEvent`:

```json
{"event":{"id":"evt-1","type":"resource.created","timestamp":"2024-01-01T00:00:00Z","resourceId":"doc-abc123","userId":"user@example.com","payload":{}},"metadata":{"sequenceNumber":1,"checksum":"sha256:...","version":"1.0"}}
```

### Views (JSON)

Materialized views are stored as JSON files with the same sharding:

```
data/
  projections/
    resources/
      ab/
        cd/
          doc-abc123.json   # Materialized view
```

## Performance

- **Sharding** - 65,536 shards using Jump Consistent Hash prevents filesystem bottlenecks
- **Append-only** - JSONL writes are fast (no updates, only appends)
- **In-memory subscriptions** - Pub/sub has zero I/O overhead
- **Lazy view materialization** - Views only built on demand or when events occur

## Error Handling

```typescript
try {
  await eventStore.appendEvent(event);
} catch (error) {
  if (error.code === 'ENOENT') {
    // Storage directory doesn't exist
  }
  throw error;
}
```

## Testing

```typescript
import { EventStore, FilesystemViewStorage } from '@semiont/event-sourcing';
import { describe, it, beforeEach } from 'vitest';

describe('Event sourcing', () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore(
      { basePath: './test-data', dataDir: './test-data', enableSharding: false },
      new FilesystemViewStorage('./test-data'),
      { baseUrl: 'http://localhost:4000' }
    );
  });

  it('should append and retrieve events', async () => {
    const event = await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId('test-1'),
      userId: userId('test@example.com'),
      payload: {},
    });

    const events = await eventStore.log.getEvents(resourceId('test-1'));
    expect(events).toHaveLength(1);
  });
});
```

## Examples

### Building a CLI Tool

```typescript
import { EventStore, FilesystemViewStorage } from '@semiont/event-sourcing';
import { resourceId, userId } from '@semiont/core';

async function rebuildViews(basePath: string) {
  const store = new EventStore(
    { basePath, dataDir: basePath, enableSharding: true },
    new FilesystemViewStorage(basePath),
    { baseUrl: 'http://localhost:4000' }
  );

  const resourceIds = await store.log.getAllResourceIds();
  console.log(`Rebuilding ${resourceIds.length} resources...`);

  for (const id of resourceIds) {
    const events = await store.log.getEvents(id);
    console.log(`Resource ${id}: ${events.length} events`);
    // Views are automatically materialized by ViewManager
  }
}
```

### Event Processing Worker

```typescript
async function startWorker() {
  const store = new EventStore(/* config */);

  // Subscribe to all annotation events
  store.bus.subscribeGlobal(async (event) => {
    if (event.event.type === 'annotation.added') {
      console.log('Processing annotation:', event.event.payload);
      // Custom processing logic here
    }
  });

  console.log('Worker started, listening for events...');
}
```

## License

Apache-2.0
