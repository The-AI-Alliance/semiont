# EventBus - Event Pub/Sub Layer

The `EventBus` class provides real-time event notifications using the publish-subscribe pattern. It manages subscriptions and delivers events to registered callbacks.

**Single Responsibility:** Event pub/sub only

**Does NOT handle:**
- Event persistence (see EventLog)
- View updates (see ViewManager)

## Creating an EventBus

```typescript
import { EventBus } from '@semiont/event-sourcing';

const eventBus = new EventBus({
  identifierConfig: {
    baseUrl: 'http://localhost:4000',
  },
});
```

**Note:** In most cases, you'll access EventBus through EventStore:

```typescript
const eventStore = new EventStore(/* config */);
const eventBus = eventStore.bus;
```

## Subscriptions

### Subscribe to Resource Events

Subscribe to events for a specific resource:

```typescript
import { resourceId } from '@semiont/core';

const subscription = eventBus.subscribe(
  resourceId('doc-abc123'),
  async (storedEvent) => {
    console.log('Event type:', storedEvent.event.type);
    console.log('Payload:', storedEvent.event.payload);
  }
);
```

The callback receives a `StoredEvent` with full metadata.

### Subscribe to Global Events

Subscribe to all system-level events (events without a resourceId):

```typescript
const globalSub = eventBus.subscribeGlobal(async (storedEvent) => {
  console.log('System event:', storedEvent.event.type);
});
```

Global subscriptions receive events like `entitytype.added` that affect the entire system.

### Unsubscribe

Subscriptions return an object with an `unsubscribe()` method:

```typescript
const sub = eventBus.subscribe(resourceId, callback);

// Later...
sub.unsubscribe();
```

**Always unsubscribe** when done to prevent memory leaks.

## Publishing Events

Publish events to all subscribers:

```typescript
await eventBus.publish(storedEvent);
```

**What Happens on Publish:**

1. **Check event type** - System event or resource event?
2. **Find subscribers** - Look up callbacks for this resource/global
3. **Notify callbacks** - Call each callback with the event

**Note:** In most cases, EventStore calls `publish()` automatically when you call `appendEvent()`.

## Event Routing

EventBus routes events based on their type:

### Resource Events

Events with a `resourceId` are routed to resource-specific subscribers:

```typescript
// Event
{
  type: 'annotation.added',
  resourceId: 'doc-123',  // ← Routes to doc-123 subscribers
  ...
}

// Subscribers that receive it
eventBus.subscribe(resourceId('doc-123'), callback);  // ✅ Receives
eventBus.subscribe(resourceId('doc-456'), callback);  // ❌ Doesn't receive
eventBus.subscribeGlobal(callback);                   // ❌ Doesn't receive
```

### System Events

Events without a `resourceId` are routed to global subscribers:

```typescript
// Event
{
  type: 'entitytype.added',
  resourceId: undefined,  // ← System event
  ...
}

// Subscribers that receive it
eventBus.subscribe(resourceId('doc-123'), callback);  // ❌ Doesn't receive
eventBus.subscribeGlobal(callback);                   // ✅ Receives
```

## Subscription Lifecycle

### Creating Subscriptions

```typescript
const subscription = eventBus.subscribe(resourceId, async (event) => {
  // Process event
  await processEvent(event);
});
```

Subscriptions are **active immediately** - they will receive the next event published.

### Managing Subscriptions

```typescript
// Check if there are subscribers
const count = eventBus.getSubscriberCount(resourceId('doc-123'));
console.log(`${count} subscribers`);

// Check total subscriptions
const total = eventBus.getTotalSubscriptions();
console.log(`${total} total subscriptions`);

// Check global subscriptions
const globalCount = eventBus.getGlobalSubscriptionCount();
console.log(`${globalCount} global subscriptions`);
```

### Cleanup

```typescript
const subscriptions = [];

// Create subscriptions
subscriptions.push(eventBus.subscribe(resourceId1, callback1));
subscriptions.push(eventBus.subscribe(resourceId2, callback2));

// Cleanup all
subscriptions.forEach(sub => sub.unsubscribe());
```

## Callback Functions

### Event Callback Signature

```typescript
type EventCallback = (storedEvent: StoredEvent) => void | Promise<void>;
```

Callbacks can be **sync or async**:

```typescript
// Synchronous callback
eventBus.subscribe(resourceId, (event) => {
  console.log('Sync:', event.event.type);
});

// Asynchronous callback
eventBus.subscribe(resourceId, async (event) => {
  await database.save(event);
  console.log('Async:', event.event.type);
});
```

### Error Handling in Callbacks

Errors in callbacks are **caught and logged** but don't stop event delivery:

```typescript
eventBus.subscribe(resourceId, async (event) => {
  throw new Error('Callback failed!');
});

await eventBus.publish(event);
// ↑ Still publishes to other subscribers
```

**Best Practice:** Handle errors inside callbacks:

```typescript
eventBus.subscribe(resourceId, async (event) => {
  try {
    await processEvent(event);
  } catch (error) {
    console.error('Event processing failed:', error);
    // Log, retry, or queue for later processing
  }
});
```

## Subscription Patterns

### Pattern 1: Process All Events

```typescript
eventBus.subscribe(resourceId('doc-123'), async (event) => {
  console.log('Processing:', event.event.type);
  await processEvent(event);
});
```

### Pattern 2: Filter by Event Type

```typescript
eventBus.subscribe(resourceId('doc-123'), async (event) => {
  if (event.event.type === 'annotation.added') {
    await handleAnnotation(event);
  }
});
```

### Pattern 3: Batch Processing

```typescript
const buffer: StoredEvent[] = [];

eventBus.subscribe(resourceId('doc-123'), (event) => {
  buffer.push(event);

  if (buffer.length >= 10) {
    processBatch(buffer);
    buffer.length = 0;
  }
});
```

### Pattern 4: Fan-Out Processing

```typescript
eventBus.subscribe(resourceId('doc-123'), async (event) => {
  // Process in multiple systems concurrently
  await Promise.all([
    updateDatabase(event),
    sendNotification(event),
    updateCache(event),
  ]);
});
```

### Pattern 5: Event Forwarding

```typescript
// Forward events to another system
eventBus.subscribe(resourceId('doc-123'), async (event) => {
  await httpClient.post('https://api.example.com/events', {
    event: event.event,
  });
});
```

## Global Singleton

EventBus uses a **global singleton** for subscriptions to ensure all EventBus instances share the same subscription registry:

```typescript
// Internal implementation detail
const globalSubscriptions = getEventSubscriptions();
```

This is critical for SSE (Server-Sent Events) real-time notifications - all parts of the application see the same subscribers.

## Performance

### Memory Usage

Each subscription stores:
- ResourceUri or global flag (8-64 bytes)
- Callback function (varies)

With 10,000 subscriptions: ~1-5 MB

### Notification Speed

Notifications are **synchronous** and **in-memory** (no I/O):

```
pub lish() calls
  ↓
getSubscribers() (hash map lookup - O(1))
  ↓
forEach callback() (O(n) where n = subscriber count)
```

For 100 subscribers: <1ms overhead per event

### Concurrency

Callbacks are called **sequentially** to preserve event ordering:

```typescript
// Called in order
callback1(event);  // Waits for completion
callback2(event);  // Then this
callback3(event);  // Then this
```

For **concurrent processing**, use Promise.all inside callbacks:

```typescript
eventBus.subscribe(resourceId, async (event) => {
  await Promise.all([
    handler1(event),
    handler2(event),
    handler3(event),
  ]);
});
```

## Best Practices

### 1. Always Unsubscribe

```typescript
// ✅ Good - Cleanup
const sub = eventBus.subscribe(resourceId, callback);
try {
  await doWork();
} finally {
  sub.unsubscribe();
}

// ❌ Bad - Memory leak
eventBus.subscribe(resourceId, callback);
// Never unsubscribes!
```

### 2. Subscribe Before Publishing

```typescript
// ✅ Good - Subscribe first
const sub = eventBus.subscribe(resourceId, callback);
await eventBus.publish(event);

// ❌ Bad - May miss event
await eventBus.publish(event);
const sub = eventBus.subscribe(resourceId, callback);
```

### 3. Handle Errors in Callbacks

```typescript
// ✅ Good - Error handling
eventBus.subscribe(resourceId, async (event) => {
  try {
    await process(event);
  } catch (error) {
    console.error('Failed:', error);
  }
});

// ❌ Bad - Uncaught errors
eventBus.subscribe(resourceId, async (event) => {
  await process(event);  // May throw!
});
```

### 4. Use Specific Subscriptions

```typescript
// ✅ Good - Specific resource
eventBus.subscribe(resourceId('doc-123'), callback);

// ❌ Bad - Global for resource events
eventBus.subscribeGlobal(async (event) => {
  if (event.event.resourceId === 'doc-123') {
    // Won't work - resource events don't go to global!
  }
});
```

### 5. Avoid Heavy Processing in Callbacks

```typescript
// ✅ Good - Quick callback, queue heavy work
eventBus.subscribe(resourceId, async (event) => {
  await jobQueue.add({ event });  // Fast
});

// ❌ Bad - Slow callback blocks other subscribers
eventBus.subscribe(resourceId, async (event) => {
  await heavyComputation(event);  // Slow!
});
```

## Testing

### Mock EventBus

```typescript
import { describe, it, vi } from 'vitest';

describe('Event handling', () => {
  it('should process events', async () => {
    const callback = vi.fn();
    const eventBus = new EventBus({ identifierConfig: { baseUrl: 'http://test' } });

    eventBus.subscribe(resourceId('test'), callback);

    await eventBus.publish(mockStoredEvent);

    expect(callback).toHaveBeenCalledWith(mockStoredEvent);
  });
});
```

### Test Subscription Cleanup

```typescript
it('should unsubscribe', () => {
  const callback = vi.fn();
  const sub = eventBus.subscribe(resourceId('test'), callback);

  expect(eventBus.getSubscriberCount(resourceId('test'))).toBe(1);

  sub.unsubscribe();

  expect(eventBus.getSubscriberCount(resourceId('test'))).toBe(0);
});
```

## Advanced Usage

### Multiple Handlers per Resource

```typescript
// All handlers receive the event
eventBus.subscribe(resourceId('doc-123'), handler1);
eventBus.subscribe(resourceId('doc-123'), handler2);
eventBus.subscribe(resourceId('doc-123'), handler3);

await eventBus.publish(event);
// Calls: handler1 → handler2 → handler3
```

### Conditional Subscriptions

```typescript
eventBus.subscribe(resourceId('doc-123'), async (event) => {
  // Only process during business hours
  const hour = new Date().getHours();
  if (hour >= 9 && hour <= 17) {
    await processEvent(event);
  }
});
```

### Subscription Registry Inspection

```typescript
// Access internal subscriptions (use carefully!)
const registry = eventBus.subscriptions;

// Get all subscriptions
const total = registry.getTotalSubscriptions();

// Get subscriptions for a resource
const count = registry.getSubscriptionCount(resourceUri);
```

## See Also

- [EventStore.md](./EventStore.md) - Orchestration layer
- [EventLog.md](./EventLog.md) - Event persistence
- [Views.md](./Views.md) - Materialized views
