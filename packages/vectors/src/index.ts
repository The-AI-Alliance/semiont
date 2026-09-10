/**
 * @semiont/vectors
 *
 * Vector storage, embedding, and semantic search for Semiont.
 * Peer to @semiont/graph and @semiont/inference.
 */

// Store
export type { VectorStore, EmbeddingChunk, AnnotationPayload, VectorSearchResult, SearchOptions } from './store/interface';
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
export { OLLAMA_BATCH_POLICY } from './embedding/ollama';
export { VOYAGE_BATCH_POLICY } from './embedding/voyage';
export { EMBEDDING_PROVIDER_RETRY, resolveDimensions } from './embedding/resolve-dimensions';
export type { EmbeddingConfig } from './embedding/factory';

// Chunking
