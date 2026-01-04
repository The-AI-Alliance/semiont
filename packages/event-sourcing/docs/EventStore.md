# EventStore - Orchestration Layer

The `EventStore` class is the main entry point for event sourcing operations. It orchestrates three focused components:

- **EventLog** - Event persistence (append, retrieve, query)
- **EventBus** - Pub/sub notifications (publish, subscribe)
- **ViewManager** - View materialization (resource and system views)

## Architecture

EventStore is a **thin coordination layer** with no state of its own. It delegates all work to specialized components:

```typescript
class EventStore {
  readonly log: EventLog;        // Persistence
  readonly bus: EventBus;        // Pub/sub
  readonly views: ViewManager;   // Views
}
```

## Creating an EventStore

```typescript
import { EventStore, FilesystemViewStorage } from '@semiont/event-sourcing';

const eventStore = new EventStore(
  // 1. Event storage configuration
  {
    basePath: './data',
    dataDir: './data/events',
    enableSharding: true,
    maxEventsPerFile: 10000,
  },
  // 2. View storage
  new FilesystemViewStorage('./data'),
  // 3. Identifier configuration
  { baseUrl: 'http://localhost:4000' }
);
```

### Configuration Parameters

#### EventStorageConfig

- `basePath` - Base directory for all storage
- `dataDir` - Directory for event JSONL files
- `enableSharding` - Enable automatic sharding (default: true)
- `maxEventsPerFile` - Maximum events per JSONL file (default: 10000)

#### IdentifierConfig

- `baseUrl` - Backend public URL for generating W3C-compliant URIs

## Appending Events

The `appendEvent` method coordinates the full event lifecycle:

```typescript
const storedEvent = await eventStore.appendEvent({
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
```

### Event Lifecycle

When you call `appendEvent()`, the EventStore performs these steps **in order**:

```
1. EventLog.append()        → Persist event to JSONL file
2. ViewManager.materialize() → Update materialized view
3. EventBus.publish()        → Notify subscribers
```

This order ensures:
- Events are durable before views are updated
- Views are consistent before subscribers are notified
- Subscribers see up-to-date views

### System-Level Events

Events without a `resourceId` are treated as system-level events:

```typescript
await eventStore.appendEvent({
  type: 'entitytype.added',
  resourceId: undefined,  // System-level
  userId: userId('admin@example.com'),
  payload: {
    entityType: 'Person',
    description: 'Human beings',
  },
});
```

System events update the system view (not resource views) and are published to global subscribers.

## Accessing Components

EventStore exposes its three components as public properties:

### EventLog

```typescript
// Get all events for a resource
const events = await eventStore.log.getEvents(resourceId('doc-123'));

// Query with filter
const recent = await eventStore.log.queryEvents(resourceId('doc-123'), {
  fromTimestamp: '2024-01-01T00:00:00Z',
});

// Get all resource IDs
const ids = await eventStore.log.getAllResourceIds();
```

See [EventLog.md](./EventLog.md) for full API.

### EventBus

```typescript
// Subscribe to resource events
const subscription = eventStore.bus.subscribe(
  resourceId('doc-123'),
  async (event) => {
    console.log('Event:', event.event.type);
  }
);

// Subscribe to all system events
const globalSub = eventStore.bus.subscribeGlobal(async (event) => {
  console.log('System event:', event.event.type);
});

// Unsubscribe
subscription.unsubscribe();
```

See [EventBus.md](./EventBus.md) for full API.

### ViewManager

```typescript
// Views are automatically materialized by appendEvent()
// But you can manually materialize if needed:
await eventStore.views.materializeResource(
  resourceId('doc-123'),
  event,
  () => eventStore.log.getEvents(resourceId('doc-123'))
);
```

See [Views.md](./Views.md) for full API.

## Event Ordering Guarantees

EventStore provides **per-resource ordering** guarantees:

- Events for the **same resource** are processed in sequence order
- Events for **different resources** may be processed concurrently
- **System events** are processed independently from resource events

```typescript
// These are guaranteed to be ordered
await eventStore.appendEvent({ resourceId: resourceId('doc-1'), /* ... */ });
await eventStore.appendEvent({ resourceId: resourceId('doc-1'), /* ... */ });

// These may execute concurrently
await Promise.all([
  eventStore.appendEvent({ resourceId: resourceId('doc-1'), /* ... */ }),
  eventStore.appendEvent({ resourceId: resourceId('doc-2'), /* ... */ }),
]);
```

## Error Handling

```typescript
try {
  await eventStore.appendEvent(event);
} catch (error) {
  // Errors from any component (log, views, bus) will bubble up
  console.error('Event append failed:', error);

  // The event may be partially persisted:
  // - If EventLog.append() fails → event not stored
  // - If ViewManager fails → event stored, view not updated
  // - If EventBus fails → event stored, view updated, subscribers not notified
}
```

**Recovery:** If view materialization or notification fails, you can:
1. Re-run the event through `ViewManager.materializeResource()`
2. Rebuild views from event history (see [Views.md](./Views.md))

## Best Practices

### 1. Use One EventStore per Application

```typescript
// ✅ Good - Single EventStore instance
const eventStore = createEventStore(config);
export { eventStore };

// ❌ Bad - Multiple EventStore instances
const store1 = new EventStore(config);
const store2 = new EventStore(config);  // Different subscriptions!
```

### 2. Subscribe Before Appending

```typescript
// ✅ Good - Subscribe first
const sub = eventStore.bus.subscribe(resourceId, handler);
await eventStore.appendEvent(event);

// ❌ Bad - May miss events
await eventStore.appendEvent(event);
const sub = eventStore.bus.subscribe(resourceId, handler);  // Too late!
```

### 3. Clean Up Subscriptions

```typescript
// ✅ Good - Unsubscribe when done
const sub = eventStore.bus.subscribe(resourceId, handler);
try {
  await doWork();
} finally {
  sub.unsubscribe();
}

// ❌ Bad - Memory leak
eventStore.bus.subscribe(resourceId, handler);
// Never unsubscribes!
```

### 4. Handle System vs Resource Events

```typescript
// ✅ Good - Explicit handling
const resourceId = event.resourceId || '__system__';
if (resourceId === '__system__') {
  // Handle system event
} else {
  // Handle resource event
}

// ❌ Bad - Assumes always resource event
await eventStore.log.getEvents(event.resourceId);  // May be undefined!
```

## Advanced Usage

### Event Replay

Rebuild all views from event history:

```typescript
async function rebuildAllViews(eventStore: EventStore) {
  const resourceIds = await eventStore.log.getAllResourceIds();

  for (const id of resourceIds) {
    const events = await eventStore.log.getEvents(id);

    for (const storedEvent of events) {
      await eventStore.views.materializeResource(
        id,
        storedEvent.event,
        () => Promise.resolve(events)
      );
    }
  }
}
```

### Custom Event Processing

Process events without triggering views or subscriptions:

```typescript
// Get raw events from log
const events = await eventStore.log.getEvents(resourceId);

// Process without side effects
for (const event of events) {
  await customProcessor(event);
}
```

### Testing with EventStore

```typescript
import { EventStore, FilesystemViewStorage } from '@semiont/event-sourcing';
import { describe, it, beforeEach, afterEach } from 'vitest';
import { rm } from 'fs/promises';

describe('Event processing', () => {
  let eventStore: EventStore;
  const testDir = './test-data';

  beforeEach(() => {
    eventStore = new EventStore(
      { basePath: testDir, dataDir: testDir, enableSharding: false },
      new FilesystemViewStorage(testDir),
      { baseUrl: 'http://localhost:4000' }
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should coordinate event lifecycle', async () => {
    const events: StoredEvent[] = [];

    eventStore.bus.subscribe(resourceId('test'), async (event) => {
      events.push(event);
    });

    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId('test'),
      userId: userId('user@test.com'),
      payload: {},
    });

    expect(events).toHaveLength(1);
  });
});
```

## See Also

- [EventLog.md](./EventLog.md) - Event persistence and queries
- [EventBus.md](./EventBus.md) - Pub/sub subscriptions
- [Views.md](./Views.md) - Materialized views
- [Configuration.md](./Configuration.md) - Setup options
