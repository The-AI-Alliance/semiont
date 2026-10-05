# @semiont/graph

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+graph%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=graph)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=graph)
[![npm version](https://img.shields.io/npm/v/@semiont/graph.svg)](https://www.npmjs.com/package/@semiont/graph)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/graph.svg)](https://www.npmjs.com/package/@semiont/graph)
[![License](https://img.shields.io/npm/l/@semiont/graph.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Graph database abstraction with Neo4j, Neptune, JanusGraph, and in-memory implementations.

## Installation

```bash
npm install @semiont/graph
```

Then install the peer dependency for your chosen graph database:

```bash
# For Neo4j
npm install neo4j-driver

# For Neptune or JanusGraph
npm install gremlin

# For Neptune with AWS SDK
npm install @aws-sdk/client-neptune

# MemoryGraph has no dependencies
```

## Architecture Context

**Infrastructure Ownership**: In a running stack, each service that uses the graph **connects to it from its own entry point in [@semiont/make-meaning](../make-meaning/)** with `getGraphDatabase()`: the Weaver (`weaver-main`) writes the projection, and the Archivist (`archivist-main`) and the Librarian (`librarian-main`) read it. `startMakeMeaning()` connects the same way when it composes the access actors in one process, for tests and embedding.

The examples below show direct usage for **testing, CLI tools, or standalone applications**. For how the services use the graph, see [@semiont/make-meaning](../make-meaning/).

## Quick Start

```typescript
import { getGraphDatabase } from '@semiont/graph';
import { resourceId, annotationId } from '@semiont/core';
import type { GraphServiceConfig } from '@semiont/core';

// The `services.graph` block of an environment config
const graphConfig: GraphServiceConfig = {
  platform: { type: 'container' },
  type: 'neo4j',
  uri: 'bolt://localhost:7687',
  username: 'neo4j',
  password: 'password',
  database: 'neo4j'
};

// Singleton factory — connects automatically
const graph = await getGraphDatabase(graphConfig);

// Create a resource (W3C ResourceDescriptor)
const resource = await graph.createResource({
  '@context': 'https://www.w3.org/ns/ldp',
  '@id': resourceId('doc-123'),
  name: 'My Document',
  entityTypes: ['Person', 'Organization'],
  representations: [{ mediaType: 'text/plain' }],
  dateCreated: new Date().toISOString()
});

// Create an annotation (W3C Web Annotation; highlights carry no body)
const annotation = await graph.createAnnotation({
  id: annotationId('anno-456'),
  motivation: 'highlighting',
  target: {
    source: resourceId('doc-123'),
    selector: { type: 'TextQuoteSelector', exact: 'Important phrase', prefix: '', suffix: '' }
  },
  creator: { '@type': 'Person', name: 'user-123' },
  created: new Date().toISOString()
});

// Query relationships
const annotations = await graph.getResourceAnnotations(resourceId('doc-123'));
```

## Features

- 🔌 **Multiple Providers** - Neo4j, AWS Neptune, JanusGraph, In-memory
- 🎯 **Unified Interface** - Same API across all providers
- 📊 **W3C Compliant** - Full Web Annotation Data Model support
- 🔄 **Event-Driven Updates** - Projected from the event log by the Weaver
- 🚀 **Rebuildable Projection** - Derived from the event log, never the source of truth
- 🔍 **Rich Queries** - Cross-document relationships and entity searches

## Documentation

- [API Reference](./docs/API.md) - API documentation
- [GraphDatabase Interface](./docs/GraphInterface.md) - The full interface contract
- [Architecture](./docs/ARCHITECTURE.md) - System design and principles
- [Eventual Consistency](./docs/EVENTUAL-CONSISTENCY.md) - Order-independent projections and race condition handling

## Supported Implementations

Each example below is the `services.graph` block of an environment config — pass it directly to `getGraphDatabase()`. (`platform` is required by the config schema but not used by this package.)

### Neo4j
Native graph database with Cypher query language.

```typescript
const graphConfig: GraphServiceConfig = {
  platform: { type: 'container' },
  type: 'neo4j',
  uri: 'bolt://localhost:7687',
  username: 'neo4j',
  password: 'password',
  database: 'neo4j'
};
```

`uri`, `username`, `password`, and `database` are values, used as given. A `${ENV_VAR}` in a KB's config is resolved once, by the config loader, before these fields are built; a value that still contains `${…}` is taken literally.

### AWS Neptune
Managed graph database supporting Gremlin.

```typescript
const graphConfig: GraphServiceConfig = {
  platform: { type: 'aws' },
  type: 'neptune',
  endpoint: 'wss://your-cluster.neptune.amazonaws.com:8182/gremlin',
  port: 8182,
  region: 'us-east-1'
};
```

If `endpoint` is omitted, the cluster endpoint is discovered via the AWS SDK using `region`.

### JanusGraph
Open-source distributed graph database.

```typescript
const graphConfig: GraphServiceConfig = {
  platform: { type: 'container' },
  type: 'janusgraph',
  host: 'localhost',
  port: 8182,
  storage: 'cassandra',
  index: 'elasticsearch'
};
```

### MemoryGraph
In-memory implementation for tests and in-process use. It lives in one process's heap, so the Weaver, the Archivist and the Librarian refuse it.

```typescript
const graphConfig: GraphServiceConfig = {
  platform: { type: 'posix' },
  type: 'memory'
};
```

## API Overview

### Core Operations

```typescript
// Resource operations
await graph.createResource(resource);
await graph.getResource(id);
await graph.updateResource(id, updates);
await graph.deleteResource(id);
await graph.listResources({ entityTypes: ['Person'] });
await graph.listResources({ search: 'query' });

// Annotation operations
await graph.createAnnotation(input);
await graph.getAnnotation(id);
await graph.updateAnnotation(id, updates);
await graph.deleteAnnotation(id);
await graph.listAnnotations({ resourceId });

// Relationship queries
await graph.getResourceAnnotations(resourceId);
await graph.getHighlights(resourceId);
await graph.getReferences(resourceId);
await graph.getResourceReferencedBy(resourceId);

// Graph traversal
await graph.getResourceConnections(resourceId);
await graph.findPath(fromResourceId, toResourceId);

// Tag collections
await graph.getEntityTypes();
await graph.addEntityType('NewType');
```

See [GraphInterface.md](./docs/GraphInterface.md) for the full contract.

## Graph as Projection

The graph database is a **read-only projection** of the event log: derived, never the source of truth, and rebuildable from the events. A stack still needs one, because the Weaver, the Archivist and the Librarian each connect to it when they start. It answers some reads and not others:

### Answered WITHOUT the Graph
✅ Viewing a resource and its annotations
✅ Creating/updating/deleting annotations
✅ Single-document workflows
✅ Real-time SSE updates

### Requires Graph
❌ Cross-document relationship queries (referenced-by, connections)
❌ Resource search by name, path or entity type
❌ Candidate search for a reference (Matcher)
❌ The knowledge-graph neighborhood in a gathered context

See [Architecture Documentation](./docs/ARCHITECTURE.md) for details.

## Performance

| Provider | Setup | Speed | Scalability | Persistence |
|----------|-------|-------|-------------|-------------|
| Neo4j | Medium | Fast | High | Yes |
| Neptune | Complex | Medium | Very High | Yes |
| JanusGraph | Complex | Medium | Very High | Yes |
| Memory | None | Very Fast | Low | No |

## Development

```bash
# Install dependencies
npm install

# Build package
npm run build

# Run tests
npm test

# Type checking
npm run typecheck
```

## License

Apache-2.0