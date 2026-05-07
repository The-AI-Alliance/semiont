# @semiont/vectors

Vector storage, embedding, and semantic search for Semiont.

Provides a pluggable abstraction over vector databases and embedding providers, with text chunking utilities. Used by the Smelter actor to index content and by Gatherer/Matcher to retrieve semantically similar resources and annotations.

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
  dimensions: 1024,
});
```

Requires a running [Qdrant](https://qdrant.tech) instance. The `@qdrant/js-client-rest` peer dependency is lazy-loaded on `connect()`. Collections are auto-created if they don't exist.

### Memory (testing)

```typescript
const store = await createVectorStore({
  type: 'memory',
  dimensions: 768,
});
```

Brute-force cosine similarity. No external dependencies.

## Embedding Providers

### Voyage AI (cloud)

```typescript
import { createEmbeddingProvider } from '@semiont/vectors';

const provider = await createEmbeddingProvider({
  type: 'voyage',
  model: 'voyage-3',       // 1024 dimensions
  apiKey: '...',
});
```

Models: `voyage-3` (1024), `voyage-3-lite` (512), `voyage-code-3`, `voyage-finance-2`, `voyage-law-2`.

### Ollama (local)

```typescript
const provider = await createEmbeddingProvider({
  type: 'ollama',
  model: 'nomic-embed-text',  // 768 dimensions
  baseURL: 'http://localhost:11434',
});
```

Models: `nomic-embed-text` (768), `all-minilm` (384), `mxbai-embed-large` (1024), `snowflake-arctic-embed` (1024).

## Text Chunking

```typescript
import { chunkText, DEFAULT_CHUNKING_CONFIG } from '@semiont/vectors';

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
  filter: { excludeResourceId: 'res-already-open' },
});

// Search annotations
const annotations = await store.searchAnnotations(embedding, {
  limit: 5,
  filter: { entityTypes: ['Person', 'Organization'], motivation: 'describing' },
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
})));

// Index an annotation
const vec = await provider.embed(annotation.exactText);
await store.upsertAnnotationVector(annotationId, {
  annotationId,
  resourceId,
  motivation: 'describing',
  entityTypes: ['Person'],
  exactText: 'Marie Curie',
}, vec);
```

## Configuration

In `semiont.toml`:

```toml
[environments.local.services.vectors]
type = "qdrant"
host = "localhost"
port = 6333

[environments.local.services.vectors.embedding]
type = "voyage"
model = "voyage-3"

[environments.local.services.vectors.chunking]
chunkSize = 512
overlap = 50
```

## License

Apache-2.0
