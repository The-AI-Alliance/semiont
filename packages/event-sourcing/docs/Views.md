# Views - Materialized View Management

The `ViewManager` class maintains materialized views (projections) of event streams. It applies events to views and provides query access to current state.

**Single Responsibility:** View materialization and queries

**Does NOT handle:**
- Event persistence (see EventLog)
- Event notifications (see EventBus)

## Creating a ViewManager

```typescript
import { ViewManager, FilesystemViewStorage } from '@semiont/event-sourcing';

const viewStorage = new FilesystemViewStorage({
  basePath: './data/views',
});

const viewManager = new ViewManager({
  storage: viewStorage,
  identifierConfig: {
    baseUrl: 'http://localhost:4000',
  },
});
```

**Note:** In most cases, you'll access ViewManager through EventStore:

```typescript
const eventStore = new EventStore(/* config */);
const viewManager = eventStore.views;
```

## View Types

### Resource Views

Resource views represent the current state of a specific resource:

```typescript
import { resourceId } from '@semiont/core';

const view = await viewManager.getResourceView(resourceId('doc-123'));
console.log('Current state:', view);
```

**Resource View Structure:**

```typescript
interface ResourceView {
  resourceUri: ResourceUri;
  resource: components['schemas']['Resource'];
  annotations: components['schemas']['Annotation'][];
}
```

### System Views

System views represent global state (entity types, schemas):

```typescript
const systemView = await viewManager.getSystemView();
console.log('Entity types:', systemView.entityTypes);
console.log('Tag schemas:', systemView.tagSchemas);
```

**System View Structure:**

```typescript
interface SystemView {
  entityTypes: components['schemas']['EntityType'][];
  tagSchemas: components['schemas']['TagSchema'][];
}
```

## Applying Events to Views

Events update views through the `applyEvent()` method:

```typescript
await viewManager.applyEvent(storedEvent);
```

**What Happens:**

1. **Check event type** - Resource event or system event?
2. **Load current view** - Get existing state from storage
3. **Apply event** - Update view based on event type
4. **Save view** - Persist updated state

**Note:** EventStore calls `applyEvent()` automatically when you append events.

## Event Type Handling

### Resource Events

Events with a `resourceId` update resource views:

```typescript
// Event
{
  type: 'annotation.added',
  resourceId: 'doc-123',
  payload: { annotation: { ... } }
}

// Updates view
{
  resourceUri: 'http://localhost:4000/resources/doc-123',
  resource: { ... },
  annotations: [...existing, newAnnotation]  // ← Added
}
```

**Resource Event Types:**
- `resource.added` - Create new resource view
- `annotation.added` - Add annotation to resource
- `annotation.modified` - Update existing annotation
- `annotation.deleted` - Remove annotation from resource

### System Events

Events without a `resourceId` update the system view:

```typescript
// Event
{
  type: 'entitytype.added',
  resourceId: undefined,
  payload: { entityType: { ... } }
}

// Updates view
{
  entityTypes: [...existing, newEntityType],  // ← Added
  tagSchemas: [...]
}
```

**System Event Types:**
- `entitytype.added` - Add entity type to catalog
- `tagschema.added` - Add tag schema to catalog

## View Queries

### Get Resource View

Retrieve current state for a specific resource:

```typescript
import { resourceId } from '@semiont/core';

const view = await viewManager.getResourceView(resourceId('doc-123'));

console.log('Resource:', view.resource);
console.log('Annotations:', view.annotations);
console.log('Annotation count:', view.annotations.length);
```

**Returns null** if the resource doesn't exist:

```typescript
const view = await viewManager.getResourceView(resourceId('unknown'));
console.log(view);  // null
```

### Get System View

Retrieve global catalog state:

```typescript
const systemView = await viewManager.getSystemView();

console.log('Entity types:', systemView.entityTypes);
console.log('Tag schemas:', systemView.tagSchemas);
```

**Always returns a view** - creates empty view if none exists:

```typescript
// First call ever
const view = await viewManager.getSystemView();
console.log(view);
// { entityTypes: [], tagSchemas: [] }
```

## View Materialization Process

### Creating a New Resource View

When a `resource.added` event is applied:

```typescript
// Event
{
  type: 'resource.added',
  resourceId: 'doc-123',
  payload: {
    resource: {
      id: 'doc-123',
      type: 'Document',
      body: { type: 'TextualBody', value: '...' }
    }
  }
}

// Creates view
{
  resourceUri: 'http://localhost:4000/resources/doc-123',
  resource: { id: 'doc-123', type: 'Document', ... },
  annotations: []
}
```

### Adding Annotations

When an `annotation.added` event is applied:

```typescript
// Event
{
  type: 'annotation.added',
  resourceId: 'doc-123',
  payload: {
    annotation: {
      id: 'anno-456',
      type: 'Annotation',
      target: { source: 'http://localhost:4000/resources/doc-123' },
      body: { type: 'TextualBody', value: 'Great point!' }
    }
  }
}

// Updates view
{
  resourceUri: 'http://localhost:4000/resources/doc-123',
  resource: { ... },
  annotations: [
    { id: 'anno-456', ... }  // ← Added to array
  ]
}
```

### Modifying Annotations

When an `annotation.modified` event is applied:

```typescript
// Event
{
  type: 'annotation.modified',
  resourceId: 'doc-123',
  payload: {
    annotationId: 'anno-456',
    annotation: {
      id: 'anno-456',
      body: { type: 'TextualBody', value: 'Updated comment!' }
    }
  }
}

// Updates view
annotations: [
  { id: 'anno-456', body: { value: 'Updated comment!' } }  // ← Replaced
]
```

### Deleting Annotations

When an `annotation.deleted` event is applied:

```typescript
// Event
{
  type: 'annotation.deleted',
  resourceId: 'doc-123',
  payload: {
    annotationId: 'anno-456'
  }
}

// Updates view
annotations: []  // ← Removed
```

## View Storage

### Storage Interface

ViewManager uses the `ViewStorage` interface:

```typescript
interface ViewStorage {
  getResourceView(uri: ResourceUri): Promise<ResourceView | null>;
  saveResourceView(view: ResourceView): Promise<void>;
  getSystemView(): Promise<SystemView>;
  saveSystemView(view: SystemView): Promise<void>;
}
```

### Filesystem Implementation

The default `FilesystemViewStorage` stores views as JSON files:

```typescript
import { FilesystemViewStorage } from '@semiont/event-sourcing';

const storage = new FilesystemViewStorage({
  basePath: './data/views',
});
```

**File Structure:**

```
data/views/
├── system.json                    # System view
└── resources/
    ├── 00/00/resource-abc123.json  # Resource view (sharded)
    └── 01/42/resource-def456.json  # Resource view (sharded)
```

**Sharding:** Resource views are distributed across 65,536 shards using jump consistent hash.

## View Consistency

### Event Ordering

Views are updated in **event sequence order**:

```typescript
// Events applied in order
await viewManager.applyEvent(event1);  // seq: 1
await viewManager.applyEvent(event2);  // seq: 2
await viewManager.applyEvent(event3);  // seq: 3

// View reflects all events up to seq: 3
```

### Eventual Consistency

Views are **eventually consistent** with the event log:

```
Event Appended → View Updated → Subscribers Notified
     ↓               ↓                 ↓
  Durable        Queryable        Observable
```

**Consistency Guarantee:** After `applyEvent()` completes, the view is guaranteed to reflect the event.

### Rebuilding Views

Views can be rebuilt from the event log:

```typescript
import { EventQuery } from '@semiont/event-sourcing';

// Delete old view
await viewStorage.saveResourceView({
  resourceUri: uri,
  resource: null,
  annotations: [],
});

// Replay events
const query = new EventQuery(eventLog);
const events = await query
  .forResource(resourceId('doc-123'))
  .execute();

for (const event of events) {
  await viewManager.applyEvent(event);
}
```

## Query Patterns

### Pattern 1: Get Current State

```typescript
const view = await viewManager.getResourceView(resourceId('doc-123'));
if (!view) {
  console.log('Resource not found');
  return;
}

console.log('Resource:', view.resource);
console.log('Annotation count:', view.annotations.length);
```

### Pattern 2: Filter Annotations

```typescript
const view = await viewManager.getResourceView(resourceId('doc-123'));

// Get all tags
const tags = view.annotations.filter(a =>
  a.body.some(b => b.type === 'Composite' && 'items' in b)
);

// Get all comments
const comments = view.annotations.filter(a =>
  a.body.some(b => b.type === 'TextualBody' && b.purpose === 'commenting')
);
```

### Pattern 3: Check Entity Type Existence

```typescript
const systemView = await viewManager.getSystemView();

const entityType = systemView.entityTypes.find(et =>
  et.id === 'Document'
);

if (entityType) {
  console.log('Entity type exists:', entityType);
}
```

### Pattern 4: List All Tag Schemas

```typescript
const systemView = await viewManager.getSystemView();

systemView.tagSchemas.forEach(schema => {
  console.log(`Schema: ${schema.id}`);
  console.log(`Tags: ${schema.tags.join(', ')}`);
});
```

## Performance

### View Size

Resource views grow with annotations:

```
Resource: ~1 KB
Each Annotation: ~0.5-2 KB

100 annotations: ~50-200 KB
1,000 annotations: ~500 KB - 2 MB
```

**Large views** (>10 MB) may be slow to load/save.

### Query Speed

View queries are **direct file reads** (no event replay):

```
getResourceView(): O(1) - Single file read
getSystemView(): O(1) - Single file read
```

For 1 MB view: ~5-10ms load time

### Update Speed

View updates are **incremental** (no full replay):

```
applyEvent():
  Load view: ~5-10ms
  Apply change: <1ms
  Save view: ~5-10ms
  Total: ~10-20ms per event
```

### Sharding Benefits

Filesystem storage uses **65,536 shards** to distribute load:

```
Single directory: 10,000 files → slow filesystem operations
Sharded: ~0.15 files per shard → fast operations
```

## Best Practices

### 1. Query Views, Not Events

```typescript
// ✅ Good - Query view
const view = await viewManager.getResourceView(resourceId);
console.log('Annotations:', view.annotations);

// ❌ Bad - Query events
const events = await eventLog.getEvents(resourceId);
const annotations = events
  .filter(e => e.event.type === 'annotation.added')
  .map(e => e.event.payload.annotation);
```

### 2. Handle Missing Views

```typescript
// ✅ Good - Check for null
const view = await viewManager.getResourceView(resourceId);
if (!view) {
  return null;
}

// ❌ Bad - Assume exists
const view = await viewManager.getResourceView(resourceId);
console.log(view.annotations.length);  // May throw!
```

### 3. Use EventStore for Updates

```typescript
// ✅ Good - Let EventStore coordinate
await eventStore.appendEvent(event);
// EventStore calls applyEvent() for you

// ❌ Bad - Manual coordination
await eventLog.append(event);
await viewManager.applyEvent(event);
await eventBus.publish(event);
```

### 4. Avoid Large Annotation Arrays

```typescript
// ✅ Good - Paginate in application
const view = await viewManager.getResourceView(resourceId);
const page = view.annotations.slice(0, 100);

// ❌ Bad - Load all annotations
const view = await viewManager.getResourceView(resourceId);
// May load 10,000+ annotations
```

### 5. Cache System View

```typescript
// ✅ Good - Cache system view
let systemViewCache = await viewManager.getSystemView();

eventBus.subscribeGlobal(async () => {
  systemViewCache = await viewManager.getSystemView();
});

// ❌ Bad - Query every time
async function getEntityType(id: string) {
  const view = await viewManager.getSystemView();
  return view.entityTypes.find(et => et.id === id);
}
```

## Testing

### Mock ViewManager

```typescript
import { describe, it, vi } from 'vitest';

describe('View queries', () => {
  it('should get resource view', async () => {
    const mockStorage = {
      getResourceView: vi.fn().mockResolvedValue({
        resourceUri: uri,
        resource: mockResource,
        annotations: [],
      }),
      saveResourceView: vi.fn(),
      getSystemView: vi.fn(),
      saveSystemView: vi.fn(),
    };

    const viewManager = new ViewManager({
      storage: mockStorage,
      identifierConfig: { baseUrl: 'http://test' },
    });

    const view = await viewManager.getResourceView(resourceId('test'));

    expect(view).toBeDefined();
    expect(view.resource).toEqual(mockResource);
  });
});
```

### Test View Updates

```typescript
it('should apply annotation.added event', async () => {
  const storage = new FilesystemViewStorage({ basePath: './test-views' });
  const viewManager = new ViewManager({
    storage,
    identifierConfig: { baseUrl: 'http://test' },
  });

  // Create resource
  await viewManager.applyEvent({
    event: {
      type: 'resource.added',
      resourceId: 'test-123',
      payload: { resource: mockResource },
    },
    sequenceNumber: 1,
    timestamp: new Date(),
  });

  // Add annotation
  await viewManager.applyEvent({
    event: {
      type: 'annotation.added',
      resourceId: 'test-123',
      payload: { annotation: mockAnnotation },
    },
    sequenceNumber: 2,
    timestamp: new Date(),
  });

  const view = await viewManager.getResourceView(resourceId('test-123'));
  expect(view.annotations).toHaveLength(1);
  expect(view.annotations[0]).toEqual(mockAnnotation);
});
```

## Advanced Usage

### Custom Storage Implementation

Implement `ViewStorage` for custom backends:

```typescript
import { ViewStorage } from '@semiont/event-sourcing';

class PostgresViewStorage implements ViewStorage {
  async getResourceView(uri: ResourceUri): Promise<ResourceView | null> {
    const row = await db.query(
      'SELECT * FROM resource_views WHERE uri = $1',
      [uri]
    );
    return row ? JSON.parse(row.data) : null;
  }

  async saveResourceView(view: ResourceView): Promise<void> {
    await db.query(
      'INSERT INTO resource_views (uri, data) VALUES ($1, $2) ON CONFLICT (uri) DO UPDATE SET data = $2',
      [view.resourceUri, JSON.stringify(view)]
    );
  }

  async getSystemView(): Promise<SystemView> {
    const row = await db.query('SELECT * FROM system_view LIMIT 1');
    return row ? JSON.parse(row.data) : { entityTypes: [], tagSchemas: [] };
  }

  async saveSystemView(view: SystemView): Promise<void> {
    await db.query(
      'INSERT INTO system_view (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1',
      [JSON.stringify(view)]
    );
  }
}
```

### View Projection Customization

Extend `ViewMaterializer` for custom projection logic:

```typescript
import { ViewMaterializer } from '@semiont/event-sourcing';

class CustomViewMaterializer extends ViewMaterializer {
  protected applyAnnotationAdded(
    view: ResourceView,
    event: StoredEvent
  ): ResourceView {
    // Custom logic for annotation.added
    const annotation = event.event.payload.annotation;

    // Add custom metadata
    const enrichedAnnotation = {
      ...annotation,
      _indexed: new Date().toISOString(),
    };

    return {
      ...view,
      annotations: [...view.annotations, enrichedAnnotation],
    };
  }
}
```

### View Snapshots

Create periodic snapshots for faster rebuilds:

```typescript
// Save snapshot
const view = await viewManager.getResourceView(resourceId);
await fs.writeFile(
  `./snapshots/resource-${resourceId}-${Date.now()}.json`,
  JSON.stringify(view)
);

// Restore from snapshot
const snapshot = JSON.parse(
  await fs.readFile('./snapshots/resource-abc123-1234567890.json', 'utf-8')
);
await viewStorage.saveResourceView(snapshot);
```

## See Also

- [EventStore.md](./EventStore.md) - Orchestration layer
- [EventLog.md](./EventLog.md) - Event persistence
- [EventBus.md](./EventBus.md) - Event notifications
