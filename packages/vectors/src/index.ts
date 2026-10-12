/**
 * @semiont/vectors
 *
 * The vector index as a reader of it searches it, and the embedding of a
 * query. The one writer of the index is the Smelter, which writes through
 * `semiont_vectors` (packages/vectors-python).
 * Peer to @semiont/graph and @semiont/inference.
 */

// Store
export type { VectorStore, VectorSearchResult, SearchOptions } from './store/interface';
export { QdrantVectorStore } from './store/qdrant';
export type { QdrantConfig } from './store/qdrant';
export { MemoryVectorStore } from './store/memory';
export { createVectorStore } from './store/factory';
export type { VectorStoreConfig } from './store/factory';
export { mergeByResource } from './store/merge';

// Embedding
export type { EmbeddingProvider } from './embedding/interface';
export { VoyageEmbeddingProvider } from './embedding/voyage';
export type { VoyageConfig } from './embedding/voyage';
export { OllamaEmbeddingProvider } from './embedding/ollama';
export type { OllamaEmbeddingConfig } from './embedding/ollama';
export { createEmbeddingProvider } from './embedding/factory';
export { EMBED_ROUND_TRIP_TIMEOUT_MS, EmbeddingProviderError, isColdModelError } from './embedding/provider-error';
export { EMBEDDING_PROVIDER_RETRY, resolveDimensions } from './embedding/resolve-dimensions';
export type { EmbeddingConfig } from './embedding/factory';
