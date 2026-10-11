# @semiont/graph

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+graph%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=graph)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=graph)
[![npm version](https://img.shields.io/npm/v/@semiont/graph.svg)](https://www.npmjs.com/package/@semiont/graph)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/graph.svg)](https://www.npmjs.com/package/@semiont/graph)
[![License](https://img.shields.io/npm/l/@semiont/graph.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The knowledge graph of a knowledge base, as a reader of it reads it: its resources and annotations as nodes and edges, for the questions that cross documents. The graph is a projection of the knowledge base's record, and a graph database sits behind one interface, `GraphDatabase`.

This package reads the graph and does not write it. The one writer is the [Weaver](../../apps/weaver/README.md), a Python service that writes through [`semiont_graph`](../graph-python/README.md).

## Who uses it

- **The Librarian**, from its entry point in [`@semiont/make-meaning`](../make-meaning/README.md), with `getGraphDatabase()`: what refers to a resource, resources by text, the Matcher's candidates, and the neighbourhood a gathered context includes.
- **The Weaver's conformance suite** ([`tests/conformance/weaver`](../../tests/conformance/weaver/README.md)), which reads the graph a Weaver built as the Librarian reads it.

**Building an application?** You do not need this package. An application asks those questions through [`@semiont/sdk`](../sdk/README.md): `gather.referencedBy`, `match.resources`, `match.search` and `gather`.

## What is in it

| | |
|---|---|
| `GraphDatabase` | The contract: read a resource and an annotation, list and search resources, what refers to a resource, a resource's connections, and how many resources each entity type has |
| `getGraphDatabase(config)` | The process's one connection, made from the `services.graph` block of a knowledge base's configuration |
| `Neo4jGraphDatabase` | Neo4j, in Cypher. It is what a stack started by the launcher runs |
| `NeptuneGraphDatabase`, `JanusGraphDatabase` | The same contract over Gremlin. **Never run against a server**: they are kept as the shape of other kinds of graph database |
| `MemoryGraphDatabase` | The contract in one process's memory, for a test: it is given what it holds when it is made |
| `intendedGraphAnnotation(annotation)` | What the graph should hold for an annotation. The graph stores what its queries need and no more, so this, and not a view, is what a check of the graph compares against |

A database's driver is an optional peer dependency, installed by whoever uses it: `neo4j-driver` for Neo4j, and `gremlin` for Neptune and JanusGraph.

## Example

```typescript
import { MemoryGraphDatabase } from '@semiont/graph';
import { resourceId } from '@semiont/core';

// A graph in memory, for a test: given what it holds, and gone with the process.
const graph = new MemoryGraphDatabase({
  resources: [{
    '@context': 'https://schema.org/',
    '@id': resourceId('doc-123'),
    name: 'My Document',
    entityTypes: ['Person'],
    representations: [{ mediaType: 'text/plain', checksum: 'sha256:abc', rel: 'original' }],
    archived: false,
    dateCreated: '2026-01-01T00:00:00.000Z',
    wasAttributedTo: { '@type': 'Person', '@id': 'did:web:example.org:users:ada', name: 'Ada' },
  }],
  annotations: [],
});

const { resources } = await graph.listResources({ entityTypes: ['Person'] });
```

## What a change must keep

- **The graph is derived, and this package never writes it.** Everything in it can be made again from the record, and the Weaver catches it up when it starts. No store here has a method that changes the graph.
- **Reading a single document needs no graph.** A resource, its annotations and their changes come from the record's views. The graph answers what crosses documents, and a reader degrades, rather than fails, when it lags.
- **Callers never ask which database they hold.** They are written to `GraphDatabase`.
- **What a row means is the codecs' alone.** [`src/annotation-codec.ts`](src/annotation-codec.ts) and [`src/resource-codec.ts`](src/resource-codec.ts) are the only places that decide what a stored property is called and which are required. The Weaver's codec is `semiont_graph`'s, and [`specs/src/graph/codec-cases.json`](../../specs/src/graph/codec-cases.json) holds the two to one answer: both run it.
- **The stores are held to a graph the Weaver wrote.** `npm test` needs no server: it holds each store's reading of a row to the codec. What a store reads from a real Neo4j is held by the Weaver's conformance suite, which reads through `Neo4jGraphDatabase` what a Weaver built from a real record.
- **Every member of `GraphDatabase` has a caller.** `scripts/compliance/audit-graph-interface-callers.sh` holds that. A member nobody calls is held by nobody.
- **A memory graph is for one process.** No configuration yields one, and the Weaver and the Librarian refuse the type, because it could not be shared between them.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): what the graph is for, what it holds, writes that take any order, and what happens when it lags.
- [API reference](docs/API.md): the factory, each store's configuration, what differs between stores, and query patterns.
- [`src/interface.ts`](src/interface.ts): the whole contract.

## License

Apache-2.0
