# Data Flow Architecture

## Overview

This document describes how data flows through the backend system, from API requests through event processing to storage and retrieval.

## Write Path

### Document Creation Flow

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant RepStore as Content Store
    participant EventStore
    participant ViewMgr as View Manager
    participant GraphDB

    Client->>API: POST /resources
    API->>RepStore: store(content)
    RepStore-->>API: checksum
    API->>EventStore: appendEvent(resource.created)
    EventStore->>ViewMgr: materialize(event)
    ViewMgr-->>EventStore: view saved
    EventStore->>GraphDB: notify(event)
    GraphDB-->>EventStore: acknowledged
    API-->>Client: 201 Created
```

### Annotation Creation Flow

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant EventStore
    participant ViewMgr as View Manager
    participant GraphDB

    Client->>API: POST /resources/:id/annotations
    API->>EventStore: appendEvent(annotation.added)
    EventStore->>ViewMgr: materialize(event)
    ViewMgr-->>EventStore: view updated
    EventStore->>GraphDB: notify(event)
    GraphDB-->>EventStore: acknowledged
    API-->>Client: 201 Created
```

## Read Path

### Single Resource Query

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant ViewStorage
    participant RepStore as Content Store

    Client->>API: GET /resources/:id
    API->>ViewStorage: getView(resourceId)
    ViewStorage-->>API: resource metadata
    API->>RepStore: get(checksum)
    RepStore-->>API: content buffer
    API-->>Client: 200 OK (resource + content)
```

### Cross-Resource Query (Graph)

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant GraphDB
    participant ViewStorage

    Client->>API: GET /resources?entityType=Person
    API->>GraphDB: findByEntityType('Person')
    GraphDB-->>API: resource IDs
    API->>ViewStorage: getViews(ids)
    ViewStorage-->>API: resource metadata
    API-->>Client: 200 OK (resources)
```

## Event Processing

### Event Store Coordination

The EventStore enforces a strict write invariant:

```typescript
async appendEvent(event: ResourceEvent): Promise<StoredEvent> {
  // 1. Persist to immutable log
  const stored = await this.log.append(event);

  // 2. Update materialized view
  await this.views.materialize(resourceId, stored);

  // 3. Notify subscribers
  await this.bus.notify(resourceId, stored);

  return stored;
}
```

### Event Consumer Pattern

```typescript
class GraphDBConsumer {
  async handleEvent(event: StoredEvent) {
    switch (event.event.type) {
      case 'resource.created':
        await this.createDocument(event);
        break;
      case 'annotation.added':
        await this.createAnnotation(event);
        break;
      // ... other event types
    }
  }
}
```

## Job Processing Flow

### Entity Detection Job

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant JobQueue
    participant Worker
    participant Inference
    participant EventStore

    Client->>API: POST /resources/:id/detect-annotations-stream
    API->>JobQueue: createJob(detection)
    API-->>Client: SSE stream started
    Worker->>JobQueue: pollNextJob()
    JobQueue-->>Worker: detection job
    Worker->>Inference: detectEntities(text)
    Inference-->>Worker: entities
    loop For each entity
        Worker->>EventStore: appendEvent(annotation.added)
    end
    Worker->>JobQueue: completeJob(result)
    API-->>Client: SSE: job complete
```

### Document Generation Job

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant JobQueue
    participant Worker
    participant Inference
    participant RepStore
    participant EventStore

    Client->>API: POST /generate-resource-stream
    API->>JobQueue: createJob(generation)
    API-->>Client: SSE stream started
    Worker->>JobQueue: pollNextJob()
    JobQueue-->>Worker: generation job
    Worker->>Inference: generateText(context)
    Inference-->>Worker: generated content
    Worker->>RepStore: store(content)
    RepStore-->>Worker: checksum
    Worker->>EventStore: appendEvent(resource.created)
    Worker->>JobQueue: completeJob(resourceId)
    API-->>Client: SSE: job complete
```

## Real-Time Updates (SSE)

### Event Streaming

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant EventStore
    participant EventBus

    Client->>API: GET /resources/:id/events/stream
    API->>EventBus: subscribe(resourceId)
    EventBus-->>API: subscription

    Note over Client,API: SSE connection established

    loop On each event
        EventStore->>EventBus: notify(event)
        EventBus->>API: event callback
        API-->>Client: SSE: event data
    end

    Client->>API: Connection close
    API->>EventBus: unsubscribe()
```

## Storage Layers

### Layer Responsibilities

1. **RepresentationStore** (L1)
   - Binary/text content storage
   - Content-addressed by checksum
   - Automatic deduplication

2. **Event Store** (L2)
   - Immutable append-only log
   - Event sequencing and chaining
   - Pub/sub notifications

3. **View Storage** (L3)
   - Materialized current state
   - Optimized for queries
   - Rebuilt from events

4. **Graph Database** (L4)
   - Relationship traversal
   - Cross-resource queries
   - Optional projection

### Data Consistency

```typescript
// Event Store ensures consistency
class EventStore {
  async appendEvent(event) {
    const tx = await this.beginTransaction();
    try {
      // Atomic operations
      const stored = await tx.persist(event);
      await tx.updateView(stored);
      await tx.commit();

      // Non-critical notifications
      this.bus.notify(stored).catch(console.error);

      return stored;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}
```

## Error Handling

### Graceful Degradation

```typescript
// Graph unavailable - fallback to views
async function queryResources(filter) {
  try {
    // Try graph first (faster for complex queries)
    return await graphDB.query(filter);
  } catch (error) {
    console.warn('Graph unavailable, using views', error);
    // Fallback to view storage
    return await viewStorage.query(filter);
  }
}
```

### Recovery Mechanisms

```typescript
// Rebuild from events
async function recover() {
  // 1. Rebuild views from events
  await eventStore.rebuildAllViews();

  // 2. Rebuild graph from events
  await graphConsumer.rebuildAll();

  // 3. Verify integrity
  await eventValidator.validateAll();
}
```

## Performance Optimizations

### Caching Strategy

- View cache: 5-minute TTL
- Content cache: Indefinite (immutable)
- Graph query cache: 1-minute TTL

### Batch Processing

```typescript
// Batch event processing
const events = await eventStore.getBatch(100);
await Promise.all(events.map(e => processor.handle(e)));
```

### Streaming

- SSE for real-time updates
- Stream large content directly
- Paginate list responses

## Monitoring Points

### Key Metrics

- Event append latency
- View materialization time
- Graph sync lag
- Job processing rate
- Cache hit ratio

### Health Checks

```typescript
app.get('/api/health', async (c) => {
  const health = {
    database: await checkDatabase(),
    eventStore: await checkEventStore(),
    graph: await checkGraph(),
    jobs: await checkJobQueue()
  };

  const status = Object.values(health).every(h => h.status === 'ok')
    ? 200 : 503;

  return c.json(health, status);
});
```

## Related Documentation

- [Event Store Architecture](../../../packages/event-sourcing/docs/ARCHITECTURE.md)
- [Graph Database Patterns](../../../packages/graph/docs/ARCHITECTURE.md)
- [Job Queue API](../../../packages/jobs/docs/API.md)
- [Content Storage](../../../packages/content/docs/API.md)