/**
 * Text Chunking Utilities
 *
 * Splits long text into overlapping chunks for embedding.
 * Each chunk is a passage that fits within the embedding model's context window.
 */
export interface ChunkingConfig {
    chunkSize: number;
    overlap: number;
}
export declare const DEFAULT_CHUNKING_CONFIG: ChunkingConfig;
/**
 * Rough token count estimate: ~4 characters per token for English text.
 *
 * Exported as the single token-estimation heuristic: `chunkText` sizes chunks
 * with it, and inference/detection budget arithmetic must use the same
 * heuristic so estimates and chunk sizes agree.
 */
export declare function estimateTokens(text: string): number;
/**
 * Split text into overlapping chunks.
 *
 * Splits on paragraph boundaries when possible, falling back to sentence
 * boundaries, then word boundaries. Each chunk overlaps with the previous
 * by `overlap` tokens worth of text.
 */
export declare function chunkText(text: string, config?: ChunkingConfig): string[];
