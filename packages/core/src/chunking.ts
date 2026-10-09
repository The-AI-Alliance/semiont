/**
 * Text Chunking Utilities
 *
 * Splits long text into overlapping chunks for embedding.
 * Each chunk is a passage that fits within the embedding model's context window.
 *
 * Every length and every position here counts Unicode code points, as a text
 * offset does: a chunk's size, the overlap, where a cut is made and where the
 * next one starts. specs/src/text/chunk-cases.json holds the rule.
 */

import { textOffsets, type TextOffsets } from './text-offsets';

export interface ChunkingConfig {
  chunkSize: number;   // approximate tokens per chunk
  overlap: number;     // tokens of overlap between adjacent chunks
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  chunkSize: 512,
  overlap: 64,
};

/** The heuristic: about four code points to a token, for English text. */
const CODE_POINTS_PER_TOKEN = 4;

/** How many tokens a text of `codePoints` code points is estimated at. */
const tokensIn = (codePoints: number): number => Math.ceil(codePoints / CODE_POINTS_PER_TOKEN);

/**
 * Rough token count estimate: a text's length in code points, divided by
 * four and rounded up.
 *
 * Exported as the single token-estimation heuristic: `chunkText` sizes chunks
 * with it, and inference/detection budget arithmetic must use the same
 * heuristic so estimates and chunk sizes agree.
 */
export function estimateTokens(text: string): number {
  return tokensIn(textOffsets(text).length);
}

/**
 * One chunk, cut from `at`, plus where the next one starts.
 *
 * `at` and `next` are offsets: they count code points from the start of
 * `text`. An `at` the text does not have is a RangeError.
 *
 * The boundary rule lives HERE and `chunkText` loops over it, so a caller that
 * must cut lazily — sizing chunk N+1 from what chunk N produced — shares the
 * exact boundary logic instead of restating it. From any `at` before the end
 * of the text `next` is further on, so a walk that stops at the end
 * terminates. The end is the text's length in code points
 * (`textOffsets(text).length`), which is less than its string's length when
 * it has a character outside the Basic Multilingual Plane; a cut made at the
 * end takes nothing and answers the end again.
 */
export function cutChunk(
  text: string,
  at: number,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG,
): { piece: string; next: number } {
  return cut(text, textOffsets(text), at, config);
}

/** `cutChunk`, given the text's conversions: a walk of one text makes them once. */
function cut(
  text: string,
  offsets: TextOffsets,
  at: number,
  config: ChunkingConfig,
): { piece: string; next: number } {
  const window = config.chunkSize * CODE_POINTS_PER_TOKEN;
  const overlap = config.overlap * CODE_POINTS_PER_TOKEN;
  const middle = at + window / 2;
  let end = Math.min(at + window, offsets.length);

  if (end < offsets.length) {
    const windowEnd = offsets.indexAt(end);
    /** Where `boundary` last starts at or before the window's end, or -1. */
    const last = (boundary: string): number => {
      const index = text.lastIndexOf(boundary, windowEnd);
      return index === -1 ? -1 : offsets.offsetAt(index);
    };

    // Try to break at a paragraph boundary
    const paraBreak = last('\n\n');
    if (paraBreak > middle) {
      end = paraBreak;
    } else {
      // Try sentence boundary
      const sentenceBreak = last('. ');
      if (sentenceBreak > middle) {
        end = sentenceBreak + 1;
      } else {
        // Try word boundary
        const wordBreak = last(' ');
        if (wordBreak > middle) {
          end = wordBreak;
        }
      }
    }
  }

  const piece = text.slice(offsets.indexAt(at), offsets.indexAt(end)).trim();

  // Reaching the end ends the walk. Backing `next` off by the overlap here
  // would hand the caller one more cut covering only text the piece just
  // returned already contains — a whole extra inference call per document,
  // yielding nothing but duplicate spans for the dedupe layer to discard.
  if (end >= offsets.length) {
    return { piece, next: offsets.length };
  }
  const nextStart = end - overlap;
  return { piece, next: nextStart > at ? nextStart : end };
}

/**
 * Split text into overlapping chunks.
 *
 * Splits on paragraph boundaries when possible, falling back to sentence
 * boundaries, then word boundaries. Each chunk overlaps with the previous
 * by `overlap` tokens worth of text.
 */
export function chunkText(text: string, config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG): string[] {
  const offsets = textOffsets(text);
  if (offsets.length === 0) return [];
  if (tokensIn(offsets.length) <= config.chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < offsets.length) {
    const { piece, next } = cut(text, offsets, start, config);
    chunks.push(piece);
    start = next;
  }

  return chunks.filter(c => c.length > 0);
}
