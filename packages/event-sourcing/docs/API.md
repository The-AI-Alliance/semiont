# Event Sourcing API Reference

## Overview

The `@semiont/event-sourcing` package provides an immutable event log with materialized views for building event-sourced applications.

## Core Components

### EventStore

The main coordinator that enforces write invariants (persist → materialize → notify).

```typescript
import { EventStore } from '@semiont/event-sourcing';
import type { ResourceId, ResourceEvent, StoredEvent } from '@semiont/core';

// Write (coordinated)
const stored: StoredEvent = await eventStore.appendEvent({
  type: 'annotation.added',
  userId: userId('user-123'),
  resourceId: resourceId('doc-456'),
  payload: { annotation }
});

// Read (direct access to components)
const events = await eventStore.log.getEvents(resourceId('doc-456'));
const view = await eventStore.views.getOrMaterialize(resourceId('doc-456'), events);
const sub = eventStore.bus.subscribe(resourceId('doc-456'), callback);
```

### EventLog

Persistence layer for the immutable event log.

```typescript
// Append event
const stored = await eventStore.log.append(event, resourceId('doc-456'));

// Get all events
const events = await eventStore.log.getEvents(resourceId('doc-456'));

// Query with filters
const filtered = await eventStore.log.queryEvents(resourceId('doc-456'), {
  eventTypes: ['annotation.added'],
  fromTimestamp: '2025-01-01T00:00:00Z'
});
```

### EventBus

Pub/sub layer for real-time event notifications.

```typescript
// Subscribe to resource events
const sub = eventStore.bus.subscribe(resourceId('doc-456'), async (event) => {
  console.log('Event:', event.event.type);
});

// Subscribe to system events
const globalSub = eventStore.bus.subscribeGlobal(async (event) => {
  console.log('System event:', event.event.type);
});

// Cleanup
sub.unsubscribe();
```

### ViewManager

Materialization layer that builds current state from events.

```typescript
// Update view (typically via EventStore.appendEvent)
await eventStore.views.materializeResource(
  resourceId('doc-456'),
  event,
  () => eventStore.log.getEvents(resourceId('doc-456'))
);

// Get or rebuild view
const view = await eventStore.views.getOrMaterialize(
  resourceId('doc-456'),
  events
);
```

## Data Types

### StoredEvent

Event with storage metadata.

```typescript
interface StoredEvent {
  event: ResourceEvent;      // The actual event
  metadata: EventMetadata;    // Storage metadata
}
```

### ResourceEvent

Core event data structure.

```typescript
interface ResourceEvent {
  id: EventId;               // UUID (branded type)
  type: EventType;           // Event type string
  userId: UserId;            // User who triggered
  resourceId?: ResourceId;   // Resource affected (optional for system events)
  timestamp: string;         // ISO 8601 timestamp
  payload: Record<string, any>; // Event-specific data
}
```

### EventMetadata

Storage tracking information.

```typescript
interface EventMetadata {
  sequenceNumber: number;    // Per-resource sequence
  streamPosition: number;    // Position in file
  timestamp: string;         // When stored
  prevEventHash?: string;    // SHA-256 of previous event
  checksum?: string;         // SHA-256 of this event
}
```

## Event Types

### Resource Events

- `resource.created` - New resource created
- `resource.cloned` - Resource cloned from another
- `resource.archived` - Resource archived
- `resource.unarchived` - Resource unarchived
- `entitytag.added` - Entity type tag added
- `entitytag.removed` - Entity type tag removed

### Annotation Events

- `annotation.added` - New annotation added
- `annotation.removed` - Annotation deleted
- `annotation.body.updated` - Annotation body modified

### System Events

- `entitytype.added` - New entity type registered globally

System events have no `resourceId` and use `'__system__'` as a special identifier.

## Storage Configuration

### Sharding

Uses 4-hex sharding (65,536 shards) with jump consistent hash for uniform distribution.

### File Rotation

Files rotate after 10,000 events (configurable via `maxEventsPerFile`).

### Storage Structure

```
dataDir/
├── events/
│   ├── 00/
│   │   ├── 00/
│   │   │   └── doc-abc123/
│   │   │       ├── events-000001.jsonl    # First 10,000 events
│   │   │       └── events-000002.jsonl    # Next 10,000 events
│   └── __system__/
│       └── events-000001.jsonl            # System events
```