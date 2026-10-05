# Graph API Reference

How to make a graph store and query it. What the graph is for, and how it stays right, is [Architecture](ARCHITECTURE.md).

## The contract

Every store implements `GraphDatabase`, in [`src/interface.ts`](../src/interface.ts). That file is the reference for each method and its types. In outline it has: connecting; writing and reading resources and annotations, one at a time and in bulk; resolving a reference; what refers to a resource, and a resource's connections; statistics; and the entity-type collection.

Its types are [`@semiont/core`](../../core/README.md)'s: a resource is a `ResourceDescriptor`, an annotation is an `Annotation`, and each is named by an id of its own kind.

## Factory

The usual entry point is the singleton factory, which takes the `services.graph` block of an environment config (`GraphServiceConfig` from `@semiont/core`), instantiates the right implementation, and connects:

```typescript
import { getGraphDatabase, closeGraphDatabase } from '@semiont/graph';

const graph = await getGraphDatabase(graphConfig);
// ... use graph ...
await closeGraphDatabase();
```

`createGraphDatabase(config)` is the non-singleton variant; it takes the factory's own flat config (`{ type, neo4jUri, neo4jUsername, … }`) rather than a `GraphServiceConfig`, and instantiates without connecting.

## The stores

Each store is exported from the package root. A database's driver (`neo4j-driver`, `gremlin`) is an optional peer dependency, loaded when the store connects.

### Neo4j

In Cypher. It is the store a stack started by the launcher runs.

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

In Gremlin.

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

In Gremlin.

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

### In-memory

The contract in one process's memory, for tests. The Weaver, the Archivist and the Librarian refuse it, because it could not be shared between them.

```typescript
import { MemoryGraphDatabase } from '@semiont/graph';

const graph = new MemoryGraphDatabase();
await graph.connect(); // No-op for memory
```

## What differs between stores

Callers are written to the contract and never ask which store they hold. Two things differ underneath:

| | Neo4j | Neptune, JanusGraph | In-memory |
|---|---|---|---|
| A property that is a list | Stored as a list | Stored as a JSON string, parsed on the way out | A JavaScript array |
| A link to a resource that is not in the graph yet | Makes a stub, filled in when the resource arrives | Needs the resource to be there | Needs no target: the link is part of the annotation |

The second row matters to whoever writes events to a store, and is explained in [Architecture](ARCHITECTURE.md#writes-that-take-any-order).

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

// Search. Every term must match the name, the storageUri or an entity type;
// results rank exact name matches first, then prefix, then every-term-in-name,
// then matches the path or a tag had to complete.
const { resources: matches } = await graph.listResources({
  search: 'Ada Lovelace',
  limit: 10
});
```

### Graph Traversal

```typescript
// Resources connected to this one through annotations
const connections = await graph.getResourceConnections(resourceId);

// Paths between two resources (up to maxDepth hops)
const paths = await graph.findPath(fromResourceId, toResourceId, 3);
```
