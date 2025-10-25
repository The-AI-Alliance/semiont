# Projection Storage Architecture

## Overview

Semiont's Projection Storage is a **Layer 3** component that provides materialized views of document state and annotations. It stores the current state of documents built from Layer 2 event streams, optimized for fast read access without requiring event replay.

**Architecture Position**: Projection Storage sits between Layer 2 (Event Store) and Layer 4 (Graph Database). Layer 1 stores raw document content, Layer 2 records events, Layer 3 materializes current state, and Layer 4 handles relationships. See [CONTENT-STORE.md](./CONTENT-STORE.md), [EVENT-STORE.md](./EVENT-STORE.md), [ARCHITECTURE.md](./ARCHITECTURE.md), and [GRAPH.md](./GRAPH.md) for complete layer details.

**Quick Navigation:**
- [Core Design Principles](#core-design-principles) - Why this architecture works
- [Module Architecture](#module-architecture) - Seven focused modules
- [Data Flow](#data-flow) - How data moves through Layer 3
- [Storage Format](#storage-format) - JSON files and sharding
- [Query Patterns](#query-patterns) - Finding projections efficiently
- [Common Operations](#common-operations) - Using the Projection API

## Core Design Principles

### 1. Single Responsibility Principle

The Projection Storage architecture applies Single Responsibility Principle across seven focused modules:

| Module | Lines | Single Responsibility |
|--------|-------|----------------------|
| [PathBuilder](#pathbuilder) | 118 | Centralized path construction and sharding |
| [ProjectionStorage](#projectionstorage) | 176 | File I/O for projections (JSON format) |
| [ProjectionQuery](#projectionquery) | 183 | Query operations (filter, search, aggregate) |
| [ProjectionManager](#projectionmanager) | 154 | **Coordinate storage and queries** |
| [ContentStorage](#contentstorage) | 125 | File I/O for document content (binary/text) |
| [ContentStreaming](#contentstreaming) | 98 | Stream operations for large files |
| [ContentManager](#contentmanager) | 87 | **Coordinate content operations** |

**Why This Matters:**
- Each module has **one reason to change**
- Testing happens in isolation (99+ tests implemented)
- No God Objects - every class earns its existence
- Easy to swap implementations (e.g., S3 instead of filesystem)

### 2. Materialized View Pattern

Projection Storage implements the Materialized View pattern:

**Event-Sourced Truth (Layer 2)**:
- All changes recorded as immutable events
- See [EVENT-STORE.md](./EVENT-STORE.md)

**Materialized Projections (Layer 3)**:
- Current state optimized for queries
- Built from events by EventProjector
- Can be rebuilt at any time
- Stored as JSON files with sharding

**Query Optimization**:
- O(1) lookups by document ID (sharded filesystem)
- Filtered queries scan projections (not events)
- Supports entity type, creator, archive status filters

**Why This Matters:**
- Fast read access without event replay
- Query without touching Layer 2
- Can add indexes/caches without changing events
- Multiple projection types from same events

### 3. Zero Cruft Philosophy

Following [CLAUDE.md](../CLAUDE.md) principles:

**NO singleton patterns:**
- All modules use factory functions
- Direct instantiation everywhere
- No global state

**NO caching layers:**
- Per explicit requirements
- Pure file I/O operations
- Caching can be added later if needed

**NO backward compatibility cruft:**
- Old singleton functions removed
- Direct fixes to all call sites
- Clean, focused interfaces

**Result**: Seven modules, each with single responsibility, zero singletons, no cruft.

## Module Architecture

### ProjectionManager

**Location**: [apps/backend/src/storage/projection/projection-manager.ts](../apps/backend/src/storage/projection/projection-manager.ts)

**Purpose**: Orchestrates projection operations across ProjectionStorage and ProjectionQuery.

**Size**: 154 lines

**Responsibilities**:
- Coordinate save → query flow
- Provide unified API surface
- Manage system projections
- Maintain backward compatibility for migration

**Key Methods**:
```typescript
// Create manager (NO singleton)
const manager = createProjectionManager({
  basePath: '/data',
  subNamespace: 'documents'
});

// Save projection (delegates to storage)
await manager.save(documentId, { document, annotations });

// Query projections (delegates to query module)
const people = await manager.query.findByEntityType('Person');
```

**Public API**:
```typescript
// Direct instantiation
const manager = new ProjectionManager(config);

// CRUD operations
await manager.save(docId, state);
const state = await manager.get(docId);
await manager.delete(docId);
const exists = await manager.exists(docId);

// Bulk operations
const all = await manager.getAll();
const ids = await manager.getAllDocumentIds();

// System projections (no sharding)
await manager.saveSystem('entity-types.json', data);
const data = await manager.getSystem('entity-types.json');

// Query access
manager.query.findByEntityType('Person');
manager.query.searchByName('alice');
```

**Tests**: 28 tests in [projection-manager.test.ts](../apps/backend/src/__tests__/storage/projection-manager.test.ts)

### ProjectionStorage

**Location**: [apps/backend/src/storage/projection/projection-storage-v2.ts](../apps/backend/src/storage/projection/projection-storage-v2.ts)

**Purpose**: Physical storage of document projections in JSON files.

**Size**: 176 lines

**Responsibilities**:
- Write projections to disk (JSON format)
- 4-hex sharding (65,536 shards) using PathBuilder
- Read projections from disk
- Parse JSON safely
- Handle CRUD operations
- System projections (unsharded)

**Storage Structure**:
```
basePath/
├── projections/
│   ├── documents/          # Main projections (sharded)
│   │   ├── 00/
│   │   │   ├── a3/
│   │   │   │   └── doc-sha256:abc123.json
│   │   │   └── f7/
│   │   │       └── doc-sha256:def456.json
│   │   └── ff/
│   │       └── cd/
│   │           └── doc-sha256:xyz789.json
│   └── __system__/         # System projections (no sharding)
│       ├── entity-types.json
│       └── stats.json
└── documents/              # Content storage (separate namespace)
    └── ...
```

**Document State Format**:
```typescript
interface DocumentState {
  document: Document;      // Metadata from @semiont/core
  annotations: DocumentAnnotations;  // W3C annotations
}
```

**Key Methods**:
```typescript
// Save projection (JSON format)
await storage.save(documentId, { document, annotations });

// Get projection
const state = await storage.get(documentId);
// Returns: { document: Document, annotations: DocumentAnnotations } | null

// Delete projection
await storage.delete(documentId);

// Check existence
const exists = await storage.exists(documentId);

// Scan operations (expensive)
const allIds = await storage.getAllDocumentIds();
const allStates = await storage.getAll();

// System projections
await storage.saveSystem('config.json', data);
const data = await storage.getSystem<Config>('config.json');
```

**Integration**: Uses PathBuilder for all path construction. Integrates with EventProjector from Layer 2 to receive projection updates. See [EVENT-STORE.md](./EVENT-STORE.md#eventprojector) for projection building logic.

**Tests**: 26 tests in [projection-storage.test.ts](../apps/backend/src/__tests__/storage/projection-storage.test.ts)

### ProjectionQuery

**Location**: [apps/backend/src/storage/projection/projection-query.ts](../apps/backend/src/storage/projection/projection-query.ts)

**Purpose**: Query operations on document projections.

**Size**: 183 lines

**Responsibilities**:
- Filter by entity type
- Filter by creator
- Filter by archive status
- Filter by annotation count
- Search by document name
- Count operations
- Aggregate queries

**Query Patterns**:
```typescript
const query = new ProjectionQuery(storage);

// Entity type queries
const people = await query.findByEntityType('Person');
const orgs = await query.findByEntityType('Organization');
const count = await query.countByEntityType('Person');

// Creator queries
const aliceDocs = await query.findByCreator('user-alice');

// Archive status
const archived = await query.findArchived();
const active = await query.findActive();

// Annotation counts
const heavily = await query.findByAnnotationCount(10);  // >= 10 annotations
const count = await query.getAnnotationCount(docId);

// Name search (case-insensitive)
const results = await query.searchByName('alice');

// Count operations
const total = await query.count();
const hasAny = await query.hasAny();
```

**Performance Characteristics**:
- All queries scan all projections (no indexes yet)
- O(n) where n = number of documents
- Fast enough for thousands of documents
- For millions, add database indexes (future enhancement)

**Tests**: 32 tests in [projection-query.test.ts](../apps/backend/src/__tests__/storage/projection-query.test.ts)

### PathBuilder

**Location**: [apps/backend/src/storage/shared/path-builder.ts](../apps/backend/src/storage/shared/path-builder.ts)

**Purpose**: Centralized path construction using sharding strategy.

**Size**: 118 lines

**Responsibilities**:
- Build sharded paths for documents
- Build system paths (no sharding)
- Ensure directories exist
- Scan for documents with specific extension
- Apply jump consistent hash sharding

**Sharding Strategy**:
```
Document ID: doc-sha256:abc123def456
             └─ Take first 8 chars: abc123de
             └─ Apply JCH: returns 0x1a3f
             └─ Split: 1a / 3f
             └─ Path: basePath/namespace/1a/3f/doc-sha256:abc123def456.ext
```

**Usage**:
```typescript
const builder = new PathBuilder({
  basePath: '/data',
  namespace: 'projections',
  subNamespace: 'documents'
});

// Build sharded path
const path = builder.buildPath('doc-123', '.json');
// Returns: /data/projections/documents/ab/cd/doc-123.json

// Build system path (no sharding)
const sysPath = builder.buildSystemPath('config.json');
// Returns: /data/projections/__system__/config.json

// Ensure directories exist
await builder.ensureDirectory(path);

// Scan for all documents
const ids = await builder.scanForDocuments('.json');
// Returns: ['doc-123', 'doc-456', ...]
```

**Why Centralized**:
- Single source of truth for sharding
- DRY - no duplicate sharding logic
- Easy to change strategy globally
- Testable in isolation

**Tests**: 13 tests in [path-builder.test.ts](../apps/backend/src/__tests__/storage/path-builder.test.ts)

### ContentManager

**Location**: [apps/backend/src/storage/content/content-manager.ts](../apps/backend/src/storage/content/content-manager.ts)

**Purpose**: Orchestrates content storage and streaming operations.

**Size**: 87 lines

**Responsibilities**:
- Coordinate ContentStorage and ContentStreaming
- Provide unified API for content operations
- Handle both regular and streaming operations

**Usage**:
```typescript
const manager = createContentManager({
  basePath: '/data'
});

// Save content (binary or text)
await manager.save(documentId, Buffer.from('content'));
await manager.save(documentId, 'text content');

// Get content (returns Buffer)
const content = await manager.get(documentId);

// Delete content
await manager.delete(documentId);

// Check existence
const exists = await manager.exists(documentId);

// Streaming (for large files)
const readStream = manager.createReadStream(documentId);
const writeStream = manager.createWriteStream(documentId);
await manager.saveStream(documentId, sourceStream);
```

### ContentStorage

**Location**: [apps/backend/src/storage/content/content-storage.ts](../apps/backend/src/storage/content/content-storage.ts)

**Purpose**: Physical storage of document content (binary/text).

**Size**: 125 lines

**Responsibilities**:
- Write content to disk (.dat files)
- Read content from disk
- Handle both string and Buffer types
- Use PathBuilder for sharded paths

**Storage Structure**:
```
basePath/
└── documents/
    ├── 00/
    │   ├── a3/
    │   │   └── doc-sha256:abc123.dat
    │   └── f7/
    │       └── doc-sha256:def456.dat
    └── ff/
        └── cd/
            └── doc-sha256:xyz789.dat
```

### ContentStreaming

**Location**: [apps/backend/src/storage/content/content-streaming.ts](../apps/backend/src/storage/content/content-streaming.ts)

**Purpose**: Stream operations for large document content.

**Size**: 98 lines

**Responsibilities**:
- Create read streams
- Create write streams
- Handle streaming uploads
- Ensure directories exist for streams

**Usage**:
```typescript
const streaming = new ContentStreaming(contentStorage);

// Read large file as stream
const readStream = streaming.createReadStream(documentId);
readStream.pipe(response);

// Write large file from stream
const writeStream = streaming.createWriteStream(documentId);
request.pipe(writeStream);

// Stream-to-stream copy
await streaming.saveStream(documentId, sourceStream);
```

## Data Flow

### Write Path (Event → Projection)

```
Layer 2: EventStore
  └─ EventProjector.projectDocument()
      └─ builds DocumentState from events
          └─ Layer 3: ProjectionManager.save()
              └─ ProjectionStorage.save()
                  └─ PathBuilder.buildPath()
                      └─ Write JSON to disk
```

### Read Path (Query)

```
Layer 1: API Route
  └─ Layer 3: ProjectionQuery.findByEntityType()
      └─ ProjectionStorage.getAllDocumentIds()
      └─ For each ID:
          └─ ProjectionStorage.get()
              └─ PathBuilder.buildPath()
                  └─ Read JSON from disk
                      └─ Filter results
                          └─ Return matches
```

### Content Flow

```
Layer 1: API Route (upload)
  └─ Layer 3: ContentManager.save()
      └─ ContentStorage.save()
          └─ PathBuilder.buildPath()
              └─ Write .dat file to disk

Layer 1: API Route (download)
  └─ Layer 3: ContentManager.get()
      └─ ContentStorage.get()
          └─ PathBuilder.buildPath()
              └─ Read .dat file from disk
                  └─ Return Buffer
```

## Storage Format

### Projection JSON Format

```json
{
  "document": {
    "id": "doc-sha256:abc123",
    "name": "My Document",
    "format": "text/plain",
    "creationMethod": "manual",
    "creator": {
      "id": "user-123",
      "type": "Person",
      "name": "Alice"
    },
    "created": "2025-01-01T00:00:00.000Z",
    "modified": "2025-01-01T00:00:00.000Z",
    "archived": false,
    "size": 1024,
    "entityTypes": ["Person", "Document"]
  },
  "annotations": {
    "@context": "http://www.w3.org/ns/anno.jsonld",
    "documentId": "doc-sha256:abc123",
    "version": 1,
    "updatedAt": "2025-01-01T00:00:00.000Z",
    "annotations": [
      {
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": "ann-123",
        "motivation": "highlighting",
        "target": { "source": "doc-sha256:abc123" },
        "body": [],
        "creator": { "id": "user-123", "type": "Person", "name": "Alice" },
        "created": "2025-01-01T00:00:00.000Z",
        "modified": "2025-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

See [W3C-WEB-ANNOTATION.md](../specs/docs/W3C-WEB-ANNOTATION.md) for complete annotation format details.

### Content Storage Format

- **Format**: Raw binary or text
- **Extension**: `.dat`
- **Encoding**: Binary (Buffer) or UTF-8 (string)
- **Size**: Unlimited (use streaming for large files)

## Query Patterns

### Fast Patterns (O(1))

```typescript
// Direct ID lookup
const state = await manager.get(documentId);
const exists = await manager.exists(documentId);
```

### Scan Patterns (O(n))

```typescript
// Entity type filter
const people = await manager.query.findByEntityType('Person');

// Creator filter
const docs = await manager.query.findByCreator('user-alice');

// Archive status
const archived = await manager.query.findArchived();
const active = await manager.query.findActive();

// Name search
const results = await manager.query.searchByName('alice');
```

### Composite Queries

```typescript
// Combine filters programmatically
const aliceDocs = await manager.query.findByCreator('user-alice');
const activeDocs = aliceDocs.filter(d => !d.document.archived);
const withAnnotations = activeDocs.filter(d => d.annotations.annotations.length > 0);
```

## Common Operations

### Initialize Managers

```typescript
import { createProjectionManager, createContentManager } from './services/storage-service';

// Projection manager (metadata + annotations)
const projectionManager = createProjectionManager({
  basePath: '/data',
  subNamespace: 'documents'
});

// Content manager (binary/text content)
const contentManager = createContentManager({
  basePath: '/data'
});
```

### Save Document (Full)

```typescript
// 1. Save content (Layer 3 - Content)
await contentManager.save(documentId, content);

// 2. Emit event (Layer 2)
const eventStore = await createEventStore();
await eventStore.appendEvent({
  type: 'document.created',
  documentId,
  userId: user.id,
  payload: { name, format, creationMethod }
});

// 3. EventProjector updates Layer 3 projection automatically
// (ProjectionManager receives update via EventProjector)
```

### Query Documents

```typescript
// Find by entity type
const people = await projectionManager.query.findByEntityType('Person');

// Find by creator
const myDocs = await projectionManager.query.findByCreator(userId);

// Search by name
const results = await projectionManager.query.searchByName('report');

// Find heavily annotated
const annotated = await projectionManager.query.findByAnnotationCount(10);
```

### Get Document (Full)

```typescript
// 1. Get metadata + annotations (Layer 3 - Projection)
const state = await projectionManager.get(documentId);

// 2. Get content (Layer 3 - Content)
const content = await contentManager.get(documentId);

// 3. Return to client
return {
  ...state.document,
  content: content.toString('utf-8')
};
```

### Delete Document

```typescript
// 1. Delete content
await contentManager.delete(documentId);

// 2. Delete projection
await projectionManager.delete(documentId);

// 3. Emit event (optional - for audit trail)
await eventStore.appendEvent({
  type: 'document.deleted',
  documentId,
  userId: user.id,
  payload: {}
});
```

## Factory Functions

All Layer 3 modules use factory functions (NO singletons):

```typescript
// Projection management
import { createProjectionManager } from './services/storage-service';
const manager = createProjectionManager(config);

// Content management
import { createContentManager } from './services/storage-service';
const manager = createContentManager(config);

// Or instantiate directly
import { ProjectionManager } from './storage/projection/projection-manager';
const manager = new ProjectionManager(config);
```

## Testing

**Test Coverage**: 99+ tests implemented

| Module | Tests | Coverage |
|--------|-------|----------|
| PathBuilder | 13 tests | Path construction, sharding, scanning |
| ProjectionStorage | 26 tests | CRUD, JSON parsing, sharding, system |
| ProjectionQuery | 32 tests | All query types, filters, aggregations |
| ProjectionManager | 28 tests | Coordination, backward compat, errors |

**Test Strategy**:
- Isolated unit tests per module
- Integration tests for coordination
- Real filesystem operations (temp directories)
- No mocks - test actual behavior

See test files:
- [path-builder.test.ts](../apps/backend/src/__tests__/storage/path-builder.test.ts)
- [projection-storage.test.ts](../apps/backend/src/__tests__/storage/projection-storage.test.ts)
- [projection-query.test.ts](../apps/backend/src/__tests__/storage/projection-query.test.ts)
- [projection-manager.test.ts](../apps/backend/src/__tests__/storage/projection-manager.test.ts)

## Migration from Singletons

Old pattern (removed):
```typescript
// ❌ OLD: Singleton pattern
import { getProjectionStorage } from './storage/projection-storage';
const storage = getProjectionStorage();  // Global singleton
```

New pattern (current):
```typescript
// ✅ NEW: Factory function
import { createProjectionManager } from './services/storage-service';
const manager = createProjectionManager(config);  // Fresh instance
```

**Migration completed**: All 15 call sites updated. See [LAYER-3-REFACTOR-PLAN.md](../LAYER-3-REFACTOR-PLAN.md) for migration details.

## Performance Considerations

### Fast Operations

- **Direct ID lookup**: O(1) - filesystem lookup
- **Existence check**: O(1) - filesystem stat
- **Single document get**: O(1) - read one file

### Slow Operations

- **Query by entity type**: O(n) - scans all projections
- **Search by name**: O(n) - scans all projections
- **Get all projections**: O(n) - loads all from disk

### Future Optimizations

1. **Add database indexes** for queries (PostgreSQL)
2. **Add in-memory cache** for hot projections (LRU)
3. **Add bloom filters** for existence checks
4. **Batch operations** for bulk imports

## Architecture Decisions

### Why No Caching?

Per explicit requirements during refactoring:
- Keep it simple initially
- Add caching layer later if needed
- Measure before optimizing

### Why Sharded Filesystem?

- Avoids filesystem limits (files per directory)
- Enables horizontal scaling
- Consistent with Layer 2 (EventStorage)
- 65,536 shards handles millions of documents

### Why Separate Content and Projections?

- Different access patterns
- Projections: small JSON, frequent queries
- Content: large binary, occasional reads
- Can optimize separately

## Related Documentation

- [EVENT-STORE.md](./EVENT-STORE.md) - Layer 2 event sourcing (feeds projections)
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Complete layer architecture
- [W3C-WEB-ANNOTATION.md](../specs/docs/W3C-WEB-ANNOTATION.md) - Annotation format in projections
- [GRAPH.md](./GRAPH.md) - Layer 4 graph database (built from projections)
- [LAYER-3-REFACTOR-PLAN.md](../LAYER-3-REFACTOR-PLAN.md) - Refactoring implementation details
- [CLAUDE.md](../CLAUDE.md) - Zero cruft philosophy

## Troubleshooting

### Projection Out of Sync

If projections don't match events:

```typescript
// Rebuild projection from events
const eventStore = await createEventStore();
const events = await eventStore.storage.getAllEvents(documentId);
const state = await eventStore.projector.projectDocument(events, documentId);
await projectionManager.save(documentId, state);
```

### Missing Content

Check both layers:

```typescript
// Check if projection exists
const hasProjection = await projectionManager.exists(documentId);

// Check if content exists
const hasContent = await contentManager.exists(documentId);

console.log({ hasProjection, hasContent });
```

### Slow Queries

Add filtering early:

```typescript
// ❌ SLOW: Get all, then filter
const all = await manager.getAll();
const filtered = all.filter(d => d.document.archived);

// ✅ FAST: Filter during scan
const filtered = await manager.query.findArchived();
```

## API Reference

See inline documentation in:
- [ProjectionManager](../apps/backend/src/storage/projection/projection-manager.ts)
- [ProjectionStorage](../apps/backend/src/storage/projection/projection-storage-v2.ts)
- [ProjectionQuery](../apps/backend/src/storage/projection/projection-query.ts)
- [ContentManager](../apps/backend/src/storage/content/content-manager.ts)
