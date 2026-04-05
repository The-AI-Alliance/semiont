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
export { createVectorStore, getVectorStore } from './store/factory';
export type { VectorStoreConfig } from './store/factory';

// Embedding
export type { EmbeddingProvider } from './embedding/interface';
export { VoyageEmbeddingProvider } from './embedding/voyage';
export type { VoyageConfig } from './embedding/voyage';
export { OllamaEmbeddingProvider } from './embedding/ollama';
export type { OllamaEmbeddingConfig } from './embedding/ollama';
export { createEmbeddingProvider } from './embedding/factory';
export type { EmbeddingConfig } from './embedding/factory';

// Chunking
export { chunkText, DEFAULT_CHUNKING_CONFIG } from './chunking';
export type { ChunkingConfig } from './chunking';
