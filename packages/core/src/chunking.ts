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
 *
 * Exported as the single token-estimation heuristic: `chunkText` sizes chunks
 * with it, and inference/detection budget arithmetic must use the same
 * heuristic so estimates and chunk sizes agree.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text into overlapping chunks.
 *
 * Splits on paragraph boundaries when possible, falling back to sentence
 * boundaries, then word boundaries. Each chunk overlaps with the previous
 * by `overlap` tokens worth of text.
 */
/**
 * One chunk, cut from `at`, plus where the next one starts.
 *
 * The boundary rule lives HERE and `chunkText` loops over it, so a caller that
 * must cut lazily — sizing chunk N+1 from what chunk N produced — shares the
 * exact boundary logic instead of restating it. `next === at` never happens:
 * the cursor always advances, so a caller's loop terminates.
 */
export function cutChunk(
  text: string,
  at: number,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG,
): { piece: string; next: number } {
  const chunkChars = config.chunkSize * 4;
  const overlapChars = config.overlap * 4;
  let end = Math.min(at + chunkChars, text.length);

  // Try to break at a paragraph boundary
  if (end < text.length) {
    const paraBreak = text.lastIndexOf('\n\n', end);
    if (paraBreak > at + chunkChars / 2) {
      end = paraBreak;
    } else {
      // Try sentence boundary
      const sentenceBreak = text.lastIndexOf('. ', end);
      if (sentenceBreak > at + chunkChars / 2) {
        end = sentenceBreak + 1;
      } else {
        // Try word boundary
        const wordBreak = text.lastIndexOf(' ', end);
        if (wordBreak > at + chunkChars / 2) {
          end = wordBreak;
        }
      }
    }
  }

  // Reaching the end ends the walk. Backing `next` off by the overlap here
  // would hand the caller one more cut covering only text the piece just
  // returned already contains — a whole extra inference call per document,
  // yielding nothing but duplicate spans for the dedupe layer to discard.



  if (end >= text.length) {
    return { piece: text.slice(at, end).trim(), next: text.length };
  }
  const nextStart = end - overlapChars;
  return { piece: text.slice(at, end).trim(), next: nextStart > at ? nextStart : end };
}

export function chunkText(text: string, config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG): string[] {
  if (text.length === 0) return [];
  const totalTokens = estimateTokens(text);
  if (totalTokens <= config.chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const { piece, next } = cutChunk(text, start, config);
    chunks.push(piece);
    start = next;
    if (start >= text.length) break;
  }

  return chunks.filter(c => c.length > 0);
}
