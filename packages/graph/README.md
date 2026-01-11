# @semiont/graph

[![npm version](https://img.shields.io/npm/v/@semiont/graph)](https://www.npmjs.com/package/@semiont/graph)
[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+graph%22)

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

## Quick Start

```typescript
import { getGraphDatabase } from '@semiont/graph';
import type { EnvironmentConfig } from '@semiont/core';

const envConfig: EnvironmentConfig = {
  services: {
    graph: {
      type: 'neo4j',
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'password',
      database: 'neo4j'
    }
  }
};

const graph = await getGraphDatabase(envConfig);

// Create a resource
const resource = await graph.createResource({
  id: 'res_123',
  type: 'Document',
  title: 'My Document'
});

// Create an annotation
const annotation = await graph.createAnnotation({
  target: { source: 'res_123' },
  body: { value: 'A note' },
  motivation: 'commenting'
});
```

## Supported Implementations

- **Neo4j** - Cypher-based graph database
- **Neptune** - AWS managed Gremlin-based graph database
- **JanusGraph** - Open-source Gremlin-based graph database
- **MemoryGraph** - In-memory implementation for testing

## Configuration

### Neo4j

```typescript
const envConfig = {
  services: {
    graph: {
      type: 'neo4j',
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'password',
      database: 'neo4j'
    }
  }
};
```

### Neptune

```typescript
const envConfig = {
  services: {
    graph: {
      type: 'neptune',
      endpoint: 'wss://your-cluster.neptune.amazonaws.com:8182/gremlin',
      port: 8182,
      region: 'us-east-1'
    }
  }
};
```

### JanusGraph

```typescript
const envConfig = {
  services: {
    graph: {
      type: 'janusgraph',
      host: 'localhost',
      port: 8182,
      storage: 'cassandra',
      index: 'elasticsearch'
    }
  }
};
```

### MemoryGraph

```typescript
const envConfig = {
  services: {
    graph: {
      type: 'memory'
    }
  }
};
```

## API Overview

See [docs/GraphInterface.md](docs/GraphInterface.md) for complete API documentation.

## License

Apache-2.0
