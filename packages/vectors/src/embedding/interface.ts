/**
 * EmbeddingProvider Interface
 *
 * Abstraction over embedding model providers (Voyage AI, Ollama).
 * Converts a text into a dense vector for similarity search.
 */

export interface EmbeddingProvider {
  /** Embed a single text string. */
  embed(text: string): Promise<number[]>;

  /**
   * The dimensionality of vectors produced by this provider.
   *
   * Discovered from the provider itself (a measured probe embedding), never
   * a hand-maintained constant. Resolved once per instance; a failed
   * discovery is not cached, so a later call retries.
   */
  dimensions(): Promise<number>;
}
