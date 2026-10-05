# Vectors API Reference

`@semiont/vectors` keeps two collections and searches them by similarity:

- **resources**: chunked full text of stored files
- **annotations**: annotations, each with its motivation, entity types and exact text

Both support filtered similarity search with a score threshold. What a knowledge base's configuration says of its vector store and its embedding model is in [Configuration](../../../docs/operator/administration/CONFIGURATION.md).

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
const store = await createVectorStore({
  type: 'memory',
  dimensions: () => provider.dimensions(),  // required by the config; this store never calls it
});
```

Brute-force cosine similarity, in one process's memory. The Librarian refuses it: a memory index cannot be shared with the Smelter that fills it.

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

## Text Chunking

```typescript
import { chunkText, DEFAULT_CHUNKING_CONFIG } from '@semiont/core';

const chunks = chunkText(longDocument, { chunkSize: 512, overlap: 50 });
// => string[]
```

Splits on paragraph boundaries, then sentence boundaries, then word boundaries. `chunkSize` and `overlap` are in tokens (~4 characters per token).

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
```

Each result includes `id`, `score`, `resourceId`, `text`, and optionally `annotationId` and `entityTypes`.

## Writing Vectors

```typescript
// Index a resource's content
const chunks = chunkText(content, DEFAULT_CHUNKING_CONFIG);
const embeddings = await provider.embedBatch(chunks);
await store.upsertResourceVectors(resourceId, chunks.map((text, i) => ({
  chunkIndex: i,
  text,
  embedding: embeddings[i],
})), contentChecksum, entityTypes);

// Index an annotation
const vec = await provider.embed('Marie Curie');
await store.upsertAnnotationVector(annotationId, vec, {
  annotationId,
  resourceId,
  motivation: 'linking',
  entityTypes: ['Person'],
  exactText: 'Marie Curie',
});
```

`upsertResourceVectors` replaces all existing vectors for the resource, so re-indexing a resource that shrank leaves no orphan chunks. `contentChecksum` is the checksum of the bytes the chunks were computed from and `entityTypes` is the resource's entity-type set; both are stamped onto every point.
