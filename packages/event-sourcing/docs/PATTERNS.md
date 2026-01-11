# Event Sourcing Patterns

## Common Usage Patterns

### Initialization

```typescript
import { createEventStore } from '@semiont/event-sourcing';
import type { EnvironmentConfig } from '@semiont/core';

const config: EnvironmentConfig = {
  services: {
    filesystem: { path: '/path/to/data' },
    backend: { publicURL: 'http://localhost:4000' }
  }
};

const eventStore = await createEventStore(config);
```

### Appending Events

```typescript
import { resourceId, userId } from '@semiont/core';

// Resource event
const stored = await eventStore.appendEvent({
  type: 'annotation.added',
  userId: userId('user-123'),
  resourceId: resourceId('doc-456'),
  payload: {
    annotation: {
      id: 'anno-789',
      target: { source: 'doc-456', selector: [...] },
      body: [...]
    }
  }
});

// System event (no resourceId)
await eventStore.appendEvent({
  type: 'entitytype.added',
  userId: userId('user-123'),
  payload: { entityType: 'NewEntityType' }
});
```

### Reading Events

```typescript
import { EventQuery } from '@semiont/event-sourcing';
import { resourceId } from '@semiont/core';

const query = new EventQuery(eventStore.log.storage);

// Get all events
const events = await query.getResourceEvents(resourceId('doc-456'));

// Query with filters
const filtered = await query.queryEvents({
  resourceId: resourceId('doc-456'),
  eventTypes: ['annotation.added'],
  fromTimestamp: '2025-01-01T00:00:00Z',
  limit: 10
});

// Get latest event
const latest = await query.getLatestEvent(resourceId('doc-456'));
```

### Subscribing to Events

```typescript
import { resourceId } from '@semiont/core';

// Resource-scoped subscription
const sub = eventStore.bus.subscribe(resourceId('doc-456'), (event) => {
  console.log('Resource event:', event.event.type);
});

// Global subscription
const globalSub = eventStore.bus.subscribeGlobal((event) => {
  console.log('System event:', event.event.type);
});

// Cleanup
sub.unsubscribe();
globalSub.unsubscribe();
```

### Validating Event Chain

```typescript
import { EventValidator } from '@semiont/event-sourcing';

const validator = new EventValidator();
const events = await query.getResourceEvents(resourceId('doc-456'));
const result = validator.validateEventChain(events);

if (!result.valid) {
  console.error('Chain validation failed:', result.errors);
}
```

## Advanced Patterns

### Event Replay

Rebuild state from events:

```typescript
// Get all events for a resource
const events = await eventStore.log.getEvents(resourceId);

// Rebuild view from scratch
const view = await eventStore.views.materialize(events);
```

### Event Filtering

Query specific event types:

```typescript
const annotations = await eventStore.log.queryEvents(resourceId, {
  eventTypes: ['annotation.added', 'annotation.removed'],
  fromTimestamp: startDate,
  toTimestamp: endDate
});
```

### Batch Processing

Process multiple events efficiently:

```typescript
const resources = ['doc-1', 'doc-2', 'doc-3'].map(resourceId);

const allEvents = await Promise.all(
  resources.map(id => eventStore.log.getEvents(id))
);
```

### Event Consumers

Create custom event consumers:

```typescript
class MyConsumer {
  async handleEvent(event: StoredEvent) {
    switch (event.event.type) {
      case 'resource.created':
        await this.handleResourceCreated(event);
        break;
      case 'annotation.added':
        await this.handleAnnotationAdded(event);
        break;
    }
  }

  start() {
    // Subscribe to all events
    eventStore.bus.subscribeGlobal(this.handleEvent.bind(this));
  }
}
```

## Best Practices

### 1. Event Design

- Keep events small and focused
- Include all data needed to rebuild state
- Use past tense for event names
- Make events immutable

### 2. Error Handling

```typescript
try {
  await eventStore.appendEvent(event);
} catch (error) {
  if (error.code === 'CHAIN_BROKEN') {
    // Handle chain integrity error
  } else if (error.code === 'STORAGE_FULL') {
    // Handle storage error
  } else {
    // Handle other errors
  }
}
```

### 3. Performance Optimization

- Use resource-scoped subscriptions over global when possible
- Batch read operations
- Cache frequently accessed views
- Use event type filters in queries

### 4. Testing

```typescript
import { createMemoryEventStore } from '@semiont/event-sourcing/testing';

describe('MyFeature', () => {
  let eventStore;

  beforeEach(() => {
    eventStore = createMemoryEventStore();
  });

  it('should emit correct events', async () => {
    await myFeature.doSomething(eventStore);

    const events = await eventStore.log.getEvents(resourceId);
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe('expected.event');
  });
});
```