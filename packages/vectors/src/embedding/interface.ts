/**
 * EmbeddingProvider Interface
 *
 * Abstraction over embedding model providers (Voyage AI, Ollama).
 * Converts text into dense vector representations for similarity search.
 */

export interface EmbeddingProvider {
  /** Embed a single text string. */
  embed(text: string): Promise<number[]>;

  /** Embed multiple texts in a single batch call. */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** The dimensionality of vectors produced by this provider. */
  dimensions(): number;

  /** The model identifier (e.g. "voyage-3", "nomic-embed-text"). */
  model(): string;
}
