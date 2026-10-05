# @semiont/vectors

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+vectors%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=vectors)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=vectors)
[![npm version](https://img.shields.io/npm/v/@semiont/vectors.svg)](https://www.npmjs.com/package/@semiont/vectors)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/vectors.svg)](https://www.npmjs.com/package/@semiont/vectors)
[![License](https://img.shields.io/npm/l/@semiont/vectors.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Vector storage, embedding, and semantic search for Semiont.

Provides a pluggable abstraction over vector databases and embedding providers. The text chunking that feeds it is `@semiont/core`'s. Used by the Smelter actor to index content and by Gatherer/Matcher to retrieve semantically similar resources and annotations.

## Architecture

Two separate vector collections:

- **resources** — chunked full-text content from stored files
- **annotations** — W3C Web Annotation entities with motivation, entity types, and exact text

Both collections support filtered similarity search with configurable score thresholds.

## Vector Stores

### Qdrant (production)

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

### Memory (testing)

```typescript
const store = await createVectorStore({
  type: 'memory',
  dimensions: () => provider.dimensions(),  // required by the config; this store never calls it
});
```

Brute-force cosine similarity. No external dependencies.

## Embedding Providers

Vector dimensionality is intrinsic to the embedding model, so it is discovered from the provider itself — `await provider.dimensions()` embeds a probe string once per instance and measures it. There is no hand-maintained model→width table: any model the provider serves works, and an unreachable provider fails loudly instead of yielding a wrong-width index.

### Voyage AI (cloud)

```typescript
import { createEmbeddingProvider } from '@semiont/vectors';

const provider = await createEmbeddingProvider({
  type: 'voyage',
  model: 'voyage-3',
  apiKey: '...',
});
```

### Ollama (local)

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

## Configuration

In a knowledge base's `.semiont/semiontconfig/<name>.toml`:

```toml
[environments.local.vectors]
type = "qdrant"
host = "localhost"
port = 6333

[environments.local.embedding]
type = "voyage"
model = "voyage-3"
apiKey = "${MY_VOYAGE_KEY}"   # the key, from a variable you name

[environments.local.embedding.chunking]
chunkSize = 512
overlap = 64
```

## License

Apache-2.0
