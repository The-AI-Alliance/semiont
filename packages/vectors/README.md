# @semiont/vectors

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+vectors%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=vectors)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=vectors)
[![npm version](https://img.shields.io/npm/v/@semiont/vectors.svg)](https://www.npmjs.com/package/@semiont/vectors)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/vectors.svg)](https://www.npmjs.com/package/@semiont/vectors)
[![License](https://img.shields.io/npm/l/@semiont/vectors.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The vector index of a knowledge base: where the embeddings of its resources and annotations are kept, and how they are searched by meaning. A vector database and an embedding model each sit behind an interface.

## Who uses it

Each service connects from its own entry point in [`@semiont/make-meaning`](../make-meaning/README.md):

- **The Smelter** is the one writer. It chunks a resource's text, embeds it, and keeps the index in step with the record.
- **The Librarian** searches it, for the Gatherer's context and the Matcher's candidates, and when a search for resources by text matches nothing.

**Building an application?** You do not need this package. An application searches through [`@semiont/sdk`](../sdk/README.md): `match.resources`, `match.search` and `gather`.

## What is in it

| | |
|---|---|
| `VectorStore` | The contract: write a resource's chunks or an annotation's vector, delete them, and search either collection with a filter and a score threshold |
| `createVectorStore(config)` | Picks the implementation from `config.type` |
| `QdrantVectorStore` | [Qdrant](https://qdrant.tech). Collections are created when missing |
| `MemoryVectorStore` | Brute-force cosine similarity in one process, for tests |
| `EmbeddingProvider` | The contract: `embed`, `embedBatch`, `dimensions()`, `model()` |
| `createEmbeddingProvider(config)` | Picks the implementation from `config.type` |
| `VoyageEmbeddingProvider`, `OllamaEmbeddingProvider` | Voyage AI, and a local Ollama |
| `mergeByResource` | Folds chunk-level hits into one result per resource |
| `@semiont/vectors/testing` | `MockEmbeddingProvider` and `deterministicVector`, for a test that needs embeddings without a model |

The chunking that feeds it, `chunkText`, is [`@semiont/core`](../core/README.md)'s.

## Example

```typescript
import { createEmbeddingProvider, createVectorStore } from '@semiont/vectors';

const provider = await createEmbeddingProvider({
  type: 'ollama',
  model: 'nomic-embed-text',
  baseURL: 'http://localhost:11434',
});

// The store asks the provider how wide its vectors are; nothing here knows.
const store = await createVectorStore({ type: 'memory', dimensions: () => provider.dimensions() });

const embedding = await provider.embed('quantum computing');
const hits = await store.searchResources(embedding, { limit: 10, scoreThreshold: 0.7 });
```

## What a change must keep

- **It is a derived store.** Every vector can be made again from the record, and the Smelter does so when it starts. Nothing here is the source of truth.
- **One writer.** Only the Smelter writes. The other services read, and a memory store is refused by them, because it could not be shared with the process that fills it.
- **A vector's width is asked of the model.** `provider.dimensions()` embeds a probe and measures it. There is no table of models and widths to keep.
- **Rewriting a resource replaces it.** `upsertResourceVectors` removes every vector the resource had, so a resource that shrank leaves no orphan chunks.
- **Vectors say how fresh they are.** Each resource's vectors carry the checksum of the content they were made from, which is how the Smelter knows what to redo.
- **Callers never ask which database or model they hold.** They are written to `VectorStore` and `EmbeddingProvider`.

## Documentation

- [API reference](docs/API.md): the stores, the providers, searching and writing.
- [Configuration](../../docs/operator/administration/CONFIGURATION.md): how a knowledge base names its vector store and embedding model.

## License

Apache-2.0
