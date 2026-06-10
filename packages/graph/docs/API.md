# Graph Database API Reference

## Overview

The `@semiont/graph` package provides a unified interface for graph databases with support for multiple backends: Neo4j, AWS Neptune, JanusGraph, and in-memory.

## GraphDatabase Interface

All implementations conform to the `GraphDatabase` interface defined in [src/interface.ts](../src/interface.ts). See [GraphInterface.md](./GraphInterface.md) for the full contract and type definitions.

Method groups at a glance:

- **Connection management** — `connect()`, `disconnect()`, `isConnected()`
- **Resource operations** — `createResource()`, `getResource()`, `updateResource()`, `deleteResource()`, `listResources()`, `searchResources()`
- **Annotation operations** — `createAnnotation()`, `getAnnotation()`, `updateAnnotation()`, `deleteAnnotation()`, `listAnnotations()`
- **Highlights and references** — `getHighlights()`, `resolveReference()`, `getReferences()`, `getEntityReferences()`
- **Relationship queries** — `getResourceAnnotations()`, `getResourceReferencedBy()`
- **Graph traversal** — `getResourceConnections()`, `findPath()`
- **Analytics** — `getEntityTypeStats()`, `getStats()`
- **Bulk operations** — `batchCreateResources()`, `createAnnotations()`, `resolveReferences()`
- **Tag collections** — `getEntityTypes()`, `addEntityType()`, `addEntityTypes()`
- **Utility** — `generateId()`, `clearDatabase()`

## Factory

The usual entry point is the singleton factory, which takes the `services.graph` block of an environment config (`GraphServiceConfig` from `@semiont/core`), instantiates the right implementation, and connects:

```typescript
import { getGraphDatabase, closeGraphDatabase } from '@semiont/graph';

const graph = await getGraphDatabase(graphConfig);
// ... use graph ...
await closeGraphDatabase();
```

`createGraphDatabase(config)` is the non-singleton variant; it instantiates without connecting.

## Provider Implementations

All implementations are exported from the package root. Drivers (`neo4j-driver`, `gremlin`) are optional peer dependencies, loaded dynamically on `connect()`.

### Neo4j

Native graph database with Cypher query language.

```typescript
import { Neo4jGraphDatabase } from '@semiont/graph';

const graph = new Neo4jGraphDatabase({
  uri: 'bolt://localhost:7687',
  username: 'neo4j',
  password: 'password',
  database: 'neo4j'
});

await graph.connect();
```

All four fields are required at connect time.

### AWS Neptune

Managed graph database supporting Gremlin.

```typescript
import { NeptuneGraphDatabase } from '@semiont/graph';

const graph = new NeptuneGraphDatabase({
  endpoint: 'wss://your-cluster.neptune.amazonaws.com:8182/gremlin',
  port: 8182,
  region: 'us-east-1'
});

await graph.connect();
```

If `endpoint` is omitted, the cluster endpoint is discovered at connect time via the AWS SDK (`@aws-sdk/client-neptune`) using `region`.

### JanusGraph

Distributed graph database with pluggable backends.

```typescript
import { JanusGraphDatabase } from '@semiont/graph';

const graph = new JanusGraphDatabase({
  host: 'localhost',
  port: 8182,
  storageBackend: 'cassandra',    // 'cassandra' | 'hbase' | 'berkeleydb'
  indexBackend: 'elasticsearch'   // 'elasticsearch' | 'solr' | 'lucene'
});

await graph.connect();
```

`host` and `port` are required at connect time.

### In-Memory

JavaScript implementation for development and testing.

```typescript
import { MemoryGraphDatabase } from '@semiont/graph';

const graph = new MemoryGraphDatabase();
await graph.connect(); // No-op for memory
```

## Data Model

The graph stores W3C-compliant types from `@semiont/core`.

### Resource Vertex

A `ResourceDescriptor` — JSON-LD metadata about a resource (`@context`, `@id`, `name`, `representations` required; plus `entityTypes`, `dateCreated`, `archived`, and other optional fields).

### Annotation Vertex

A W3C Web Annotation (`Annotation` from `@semiont/core`): `id`, `motivation`, `target` (source resource plus optional selector), optional `body`, and `creator`. In Neo4j, annotations also get a label derived from their motivation (e.g. `:Annotation:Linking`) for fast filtering.

### Other Vertices

- **EntityType** — one vertex per entity type tag, linked from annotations
- **TagCollection** — append-only collections of known entity types

### Edges

- **BELONGS_TO** — Annotation → Resource it annotates (target source)
- **REFERENCES** — Annotation → Resource it links to (if resolved)
- **TAGGED_AS** — Annotation → EntityType

## Query Patterns

### Finding Annotations

```typescript
// All annotations on a resource
const annotations = await graph.getResourceAnnotations(resourceId);

// Highlights only / references only
const highlights = await graph.getHighlights(resourceId);
const references = await graph.getReferences(resourceId);

// Annotations on other resources that link TO this resource
const referencedBy = await graph.getResourceReferencedBy(resourceId);
```

### Finding Resources

```typescript
// Filter by entity types (with pagination)
const { resources, total } = await graph.listResources({
  entityTypes: ['Person'],
  limit: 20,
  offset: 0
});

// Full-text-ish name/content search
const matches = await graph.searchResources('Ada Lovelace', 10);
```

### Graph Traversal

```typescript
// Resources connected to this one through annotations
const connections = await graph.getResourceConnections(resourceId);

// Paths between two resources (up to maxDepth hops)
const paths = await graph.findPath(fromResourceId, toResourceId, 3);
```

## Provider-Specific Features

### Array Property Handling

Different databases handle arrays differently:

| Provider | Storage | Retrieval |
|----------|---------|-----------|
| Neo4j | Native arrays | Direct access |
| Neptune | JSON strings | Parse after retrieval |
| JanusGraph | JSON strings | Parse after retrieval |
| Memory | JavaScript arrays | Direct access |

This is internal to each implementation — the `GraphDatabase` interface always returns parsed values.
