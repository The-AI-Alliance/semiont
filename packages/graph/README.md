# @semiont/graph

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+graph%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=graph)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=graph)
[![npm version](https://img.shields.io/npm/v/@semiont/graph.svg)](https://www.npmjs.com/package/@semiont/graph)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/graph.svg)](https://www.npmjs.com/package/@semiont/graph)
[![License](https://img.shields.io/npm/l/@semiont/graph.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The knowledge graph of a knowledge base: its resources and annotations as nodes and edges, for the questions that cross documents. The graph is a projection of the knowledge base's record, and a graph database sits behind one interface, `GraphDatabase`.

## Who uses it

Each service connects from its own entry point in [`@semiont/make-meaning`](../make-meaning/README.md), with `getGraphDatabase()`:

- **The Weaver** is the one writer. It projects the record's events into the graph.
- **The Archivist and the Librarian** read it: what refers to a resource, resources by name or entity type, the Matcher's candidates, and the neighbourhood a gathered context includes.

`startMakeMeaning()` connects the same way in one process, for scripts and tests.

**Building an application?** You do not need this package. An application asks those questions through [`@semiont/sdk`](../sdk/README.md): `browse.referencedBy`, `browse.resources`, `match.search` and `gather`.

## What is in it

| | |
|---|---|
| `GraphDatabase` | The contract: write and read resources and annotations, list and search, what refers to a resource, a resource's connections, and the entity-type collection |
| `getGraphDatabase(config)` | The process's one connection, made from the `services.graph` block of a knowledge base's configuration. `closeGraphDatabase()` ends it |
| `Neo4jGraphDatabase` | Neo4j, in Cypher. It is what a stack started by the launcher runs |
| `NeptuneGraphDatabase`, `JanusGraphDatabase` | The same contract over Gremlin |
| `MemoryGraphDatabase` | The contract in one process's memory, for tests |
| `intendedGraphAnnotation(annotation)` | What the graph should hold for an annotation. The graph stores what its queries need and no more, so this, and not a view, is what a check of the graph compares against |
| `compareByRecencyThenId` | The order every listing of resources carries: newest first, ties broken by id, so that paging neither repeats nor drops a row |

A database's driver is an optional peer dependency, installed by whoever uses it: `neo4j-driver` for Neo4j, and `gremlin` for Neptune and JanusGraph.

## Example

```typescript
import { getGraphDatabase } from '@semiont/graph';
import { resourceId } from '@semiont/core';

// The in-memory graph: no server, and gone when the process ends.
const graph = await getGraphDatabase({ platform: { type: 'posix' }, type: 'memory' });

await graph.createResource({
  '@context': 'https://www.w3.org/ns/ldp',
  '@id': resourceId('doc-123'),
  name: 'My Document',
  entityTypes: ['Person'],
  representations: [{ mediaType: 'text/plain' }],
  dateCreated: new Date().toISOString(),
});

const { resources } = await graph.listResources({ entityTypes: ['Person'] });
```

## What a change must keep

- **The graph is derived.** Everything in it can be made again from the record, and the Weaver catches it up when it starts. It is never the source of truth, and nothing writes to it but the Weaver.
- **Writes are idempotent and take any order.** Events for different resources reach the graph in no fixed order, so a write never assumes the thing it points at is there yet. [Eventual Consistency](docs/EVENTUAL-CONSISTENCY.md) is how.
- **Reading a single document needs no graph.** A resource, its annotations and their changes come from the record's views. The graph answers what crosses documents, and a reader degrades, rather than fails, when it lags.
- **Callers never ask which database they hold.** They are written to `GraphDatabase`.
- **A memory graph is for one process.** The Weaver, the Archivist and the Librarian refuse it, because it could not be shared between them.

## Documentation

- [API reference](docs/API.md): the factory, each database's configuration, the data model and query patterns.
- [GraphDatabase interface](docs/GraphInterface.md): the whole contract.
- [Architecture](docs/ARCHITECTURE.md): the projection, and what works without it.
- [Eventual Consistency](docs/EVENTUAL-CONSISTENCY.md): order-independent writes.

## License

Apache-2.0
