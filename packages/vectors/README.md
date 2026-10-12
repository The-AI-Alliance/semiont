# @semiont/vectors

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+vectors%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=vectors)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=vectors)
[![npm version](https://img.shields.io/npm/v/@semiont/vectors.svg)](https://www.npmjs.com/package/@semiont/vectors)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/vectors.svg)](https://www.npmjs.com/package/@semiont/vectors)
[![License](https://img.shields.io/npm/l/@semiont/vectors.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The vector index of a knowledge base, as a reader of it searches it: similarity search over the embeddings of its resources and annotations, and the embedding of the text a search is for. A vector database and an embedding model each sit behind an interface.

## Who uses it

- **The Librarian** searches the index, for the Gatherer's context and the Matcher's candidates, and when a search for resources by text matches nothing. It connects from its entry point in [`@semiont/make-meaning`](../make-meaning/README.md).

Nothing here writes a point. The one writer of the index is the [Smelter](../../docs/protocol/SMELTER.md), a Python service that writes through [`semiont_vectors`](../vectors-python/README.md).

**Building an application?** You do not need this package. An application searches through [`@semiont/sdk`](../sdk/README.md): `match.resources`, `match.search` and `gather`.

## What is in it

| | |
|---|---|
| `VectorStore` | The contract: connect, and search either collection with a filter and a score threshold, by a vector or by a resource's own vectors |
| `createVectorStore(config)` | Makes a connected store. `config.type` is `qdrant`; no configuration yields an in-memory one |
| `QdrantVectorStore` | [Qdrant](https://qdrant.tech). Collections are created when missing |
| `MemoryVectorStore` | Brute-force cosine similarity in one process, for tests. It is made holding its points |
| `EmbeddingProvider` | The contract: `embed` and `dimensions()` |
| `createEmbeddingProvider(config)` | Picks the implementation from `config.type` |
| `VoyageEmbeddingProvider`, `OllamaEmbeddingProvider` | Voyage AI, and a local Ollama |
| `mergeByResource` | Folds chunk-level hits into one result per resource |
| `@semiont/vectors/testing` | `MockEmbeddingProvider` and `deterministicVector`, for a test that needs embeddings without a model |

## Example

```typescript
import { createEmbeddingProvider, createVectorStore } from '@semiont/vectors';

const provider = await createEmbeddingProvider({
  type: 'ollama',
  model: 'nomic-embed-text',
  baseURL: 'http://localhost:11434',
});

// The store asks the provider how wide its vectors are; nothing here knows.
const store = await createVectorStore({
  type: 'qdrant',
  host: 'localhost',
  port: 6333,
  dimensions: () => provider.dimensions(),
});

const embedding = await provider.embed('quantum computing');
const hits = await store.searchResources(embedding, { limit: 10, scoreThreshold: 0.7 });
```

## What a change must keep

- **It is a derived store.** Every vector can be made again from the record, and the Smelter does so when it starts. Nothing here is the source of truth.
- **One writer.** Only the Smelter writes a point. This package searches, and a memory store is refused by a service, because it could not be shared with the process that fills it.
- **A point is read as the writer wrote it.** What a search answers from a point's payload is stated in [`payload-cases.json`](../../specs/src/vectors/payload-cases.json), which this package's stores and the Smelter's are both held to.
- **A vector's width is asked of the model.** `provider.dimensions()` embeds a probe and measures it. There is no table of models and widths to keep.
- **One gate for each provider.** Every request to an embedding provider acquires from a gate held on the provider, so the number in flight is capped across every caller in the process.
- **Callers never ask which database or model they hold.** They are written to `VectorStore` and `EmbeddingProvider`.

## Documentation

- [API reference](docs/API.md): the stores, the providers, and searching.
- [Configuration](../../docs/operator/administration/CONFIGURATION.md): how a knowledge base names its vector store and embedding model.

## License

Apache-2.0
