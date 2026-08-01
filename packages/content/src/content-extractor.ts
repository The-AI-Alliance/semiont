/**
 * ContentExtractor — strategy-keyed text extraction for embedding.
 *
 * The registry is keyed by `TextExtraction` from `@semiont/core` — the
 * media-type registry's dispatch vocabulary — never by a second media-type
 * list (SMELTER-MEDIA-TYPES.md, Design §1): there is exactly one media-type
 * table in the system, and this registry consumes it. The Smelter resolves
 * `textExtractionOf(contentType)` and looks the extractor up by strategy; a
 * `null` slot means decline (settle skipped, reason 'no-extractor').
 *
 * Extraction is ephemeral: `extract` runs at read time, its output feeds the
 * chunker, and is discarded — no stored derived representation. Annotations
 * anchor to native geometry (`blocks`), never to extracted-text offsets, so
 * re-extraction can never break an anchor.
 */

import type { TextExtraction } from '@semiont/core';
import { decodeRepresentation } from '@semiont/core';
import type { PdfTextItem } from './pdf-text-layer';

export interface ExtractedText {
  /** Reading-order plain text, ready for the chunker. */
  text: string;
  /** Native geometry (page+bbox) for callers that anchor; absent for pure text. */
  blocks?: PdfTextItem[];
  method: 'text-passthrough' | 'pdf-text-layer' | 'table' | 'form' | 'ocr';
  pdfClass?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
}

export interface ContentExtractor {
  /**
   * Extract embeddable/annotatable text; `null` ⇒ decline (encrypted,
   * corrupt, scanned-without-OCR). The caller skips embedding and settles
   * skipped with the class reason.
   */
  extract(content: Buffer, mediaType: string): Promise<ExtractedText | null>;
}

/** Charset-aware decode of textual bytes — the pre-registry behavior, now
 *  scoped as the 'decode' strategy's extractor. Never declines: any byte
 *  sequence decodes to *some* string; emptiness is the caller's call. */
const passthroughExtractor: ContentExtractor = {
  async extract(content, mediaType) {
    return { text: decodeRepresentation(content, mediaType), method: 'text-passthrough' };
  },
};

/**
 * Strategy → extractor. A `null` slot is a decline: the strategy names a
 * capability nothing currently provides ('pdf-text-layer' until Phase 1
 * fills it; 'none' permanently).
 */
export const EXTRACTORS: Record<TextExtraction, ContentExtractor | null> = {
  'decode': passthroughExtractor,
  'pdf-text-layer': null,
  'none': null,
};
