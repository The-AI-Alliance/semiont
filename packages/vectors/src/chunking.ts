/**
 * Text Chunking Utilities
 *
 * Splits long text into overlapping chunks for embedding.
 * Each chunk is a passage that fits within the embedding model's context window.
 */

export interface ChunkingConfig {
  chunkSize: number;   // approximate tokens per chunk
  overlap: number;     // tokens of overlap between adjacent chunks
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  chunkSize: 512,
  overlap: 64,
};

/**
 * Rough token count estimate: ~4 characters per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text into overlapping chunks.
 *
 * Splits on paragraph boundaries when possible, falling back to sentence
 * boundaries, then word boundaries. Each chunk overlaps with the previous
 * by `overlap` tokens worth of text.
 */
export function chunkText(text: string, config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG): string[] {
  const totalTokens = estimateTokens(text);
  if (totalTokens <= config.chunkSize) {
    return [text];
  }

  const chunkChars = config.chunkSize * 4;
  const overlapChars = config.overlap * 4;
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkChars, text.length);

    // Try to break at a paragraph boundary
    if (end < text.length) {
      const paraBreak = text.lastIndexOf('\n\n', end);
      if (paraBreak > start + chunkChars / 2) {
        end = paraBreak;
      } else {
        // Try sentence boundary
        const sentenceBreak = text.lastIndexOf('. ', end);
        if (sentenceBreak > start + chunkChars / 2) {
          end = sentenceBreak + 1;
        } else {
          // Try word boundary
          const wordBreak = text.lastIndexOf(' ', end);
          if (wordBreak > start + chunkChars / 2) {
            end = wordBreak;
          }
        }
      }
    }

    chunks.push(text.slice(start, end).trim());
    start = end - overlapChars;
    if (start >= text.length) break;
  }

  return chunks.filter(c => c.length > 0);
}
