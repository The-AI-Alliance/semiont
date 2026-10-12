# Vectors API Reference

`@semiont/vectors` searches two collections by similarity:

- **resources**: chunked full text of stored files
- **annotations**: annotations, each with its motivation, entity types and exact text

Both support filtered similarity search with a score threshold. The points are written by the [Smelter](../../../docs/protocol/SMELTER.md), and nothing here writes one. What a knowledge base's configuration says of its vector store and its embedding model is in [Configuration](../../../docs/operator/administration/CONFIGURATION.md).

## Vector Stores

### Qdrant

```typescript
import { createVectorStore } from '@semiont/vectors';

const store = await createVectorStore({
  type: 'qdrant',
  host: 'localhost',
  port: 6333,
  // A thunk over an embedding provider (below), called only to create a collection
  dimensions: () => provider.dimensions(),
});
```

Requires a running [Qdrant](https://qdrant.tech) instance. The `@qdrant/js-client-rest` client is lazy-loaded on `connect()`. Collections are auto-created if they don't exist.

### Memory

```typescript
import { MemoryVectorStore } from '@semiont/vectors';

const store = new MemoryVectorStore({
  resources: [
    { id: 'doc-1-0', vector: [1, 0, 0], payload: { resourceId: 'doc-1', chunkIndex: 0, text: 'A chunk.', entityTypes: [] } },
  ],
  annotations: [],
});
```

Brute-force cosine similarity, in one process's memory, for a test of something that searches the index. It is made holding its points, each as the index holds one: an id, a vector and a payload. `createVectorStore` makes none, and the Librarian refuses the type: a memory index cannot be shared with the Smelter that fills it.

## Embedding Providers

Vector dimensionality is intrinsic to the embedding model, so it is discovered from the provider itself — `await provider.dimensions()` embeds a probe string once per instance and measures it. There is no hand-maintained model→width table: any model the provider serves works, and an unreachable provider fails loudly instead of yielding a wrong-width index.

### Voyage AI

```typescript
import { createEmbeddingProvider } from '@semiont/vectors';

const provider = await createEmbeddingProvider({
  type: 'voyage',
  model: 'voyage-3',
  apiKey: '...',
});
```

### Ollama

```typescript
const provider = await createEmbeddingProvider({
  type: 'ollama',
  model: 'nomic-embed-text',
  baseURL: 'http://localhost:11434',
});
```

## Search

```typescript
const embedding = await provider.embed('quantum computing');

// Search resources
const resources = await store.searchResources(embedding, {
  limit: 10,
  scoreThreshold: 0.7,
  filter: { excludeResourceId: openResourceId },  // a ResourceId
});

// Search annotations
const annotations = await store.searchAnnotations(embedding, {
  limit: 5,
  filter: { entityTypes: ['Person', 'Organization'], motivation: 'linking' },
});

// Resources like one the index already holds, by its own vectors
const similar = await store.searchByResource(openResourceId, { limit: 10 });
```

Each result includes `id`, `score`, `resourceId`, `text`, and optionally `annotationId`, `entityTypes` and `machineRead`.
