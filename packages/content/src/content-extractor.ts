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
import { pdfExtractor } from './pdf-extractor';

export interface ExtractedText {
  /** Reading-order plain text, ready for the chunker. */
  text: string;
  /** Native geometry (page+bbox) for callers that anchor; absent for pure text. */
  blocks?: PdfTextItem[];
  method: 'text-passthrough' | 'pdf-text-layer' | 'table' | 'form' | 'ocr';
  pdfClass?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  /**
   * 1-indexed pages this extraction could not read — present only when a
   * document is partially covered (class C). Naming the gap is the point:
   * without it a hybrid document embeds its native pages and says nothing
   * about the rest, so coverage silently overstates what search can see.
   * This is the work list OCR consumes.
   */
  unreadPages?: number[];
}

/**
 * A named decline — an extractor that ran and decided it cannot yield text
 * says why, so the settled signal can carry the class reason (a bare null
 * could not name its class; SMELTER-MEDIA-TYPES Phase 0 log, note a).
 */
export interface ExtractionDecline {
  declined: 'no-text-layer' | 'encrypted' | 'corrupt' | 'too-large';
}

export interface ContentExtractor {
  /**
   * Extract embeddable/annotatable text, or decline with the class reason
   * (scanned-without-OCR, encrypted, corrupt). The caller skips embedding
   * and settles skipped with that reason.
   */
  extract(content: Buffer, mediaType: string): Promise<ExtractedText | ExtractionDecline>;
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
 * capability nothing currently provides ('none' permanently).
 */
export const EXTRACTORS: Record<TextExtraction, ContentExtractor | null> = {
  'decode': passthroughExtractor,
  'pdf-text-layer': pdfExtractor,
  'none': null,
};
