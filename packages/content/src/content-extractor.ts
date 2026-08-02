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
 * anchor to native geometry (`items`), never to extracted-text offsets, so
 * re-extraction can never break an anchor.
 */

import { decodeRepresentation, type TextExtraction, type PdfTextItem } from '@semiont/core';
import type { AnchoredTextStore } from './anchored-text-store';
import { pdfExtractor } from './pdf-extractor';

export interface ExtractedText {
  /** Reading-order plain text, ready for the chunker. */
  text: string;
  /**
   * Positioned text runs indexing `text`, for callers that anchor; absent for
   * pure text, where character offsets are the anchor. Named `items` to match
   * `AnchoredText`/`PdfTextLayer` — one concept, one name, and no collision
   * with the OCR engine's own "blocks" (which are page regions, not runs).
   */
  items?: PdfTextItem[];
  method: 'text-passthrough' | 'pdf-text-layer' | 'table' | 'form' | 'ocr';
  pdfClass?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  /**
   * How well the engine read the pixels, when any of this text came from OCR.
   *
   * Extraction quality, deliberately NOT anchor confidence: the two answer
   * different questions. `AnchorConfidence` asks whether the renderer
   * relocated a stored span in the current text, and for a PDF the answer is
   * always "exactly" — the viewrect is absolute. This asks whether the glyphs
   * under that box were read correctly, which no client can recompute.
   * Reported for operators rather than stored on annotations, following the
   * existing rule that anchor-audit detail belongs in logs.
   */
  ocrConfidence?: {
    /** Mean per-word confidence, 0–100. */
    mean: number;
    /** Words the engine was unsure of — the number worth acting on. */
    lowConfidenceWords: number;
    totalWords: number;
  };
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

/**
 * Where a strategy may reuse an earlier recognition, and under what key.
 *
 * The caller supplies the key because it already has one — the content
 * checksum on `smelt:settled` / `getChecksum(descriptor)`. Hashing a large PDF
 * per job is precisely the cost this cache exists to remove, not add.
 *
 * Optional throughout: every existing caller passes nothing and is unaffected.
 * Only strategies with an expensive engine behind them consult it, so a
 * document that never OCRs never produces an entry.
 */
export interface ExtractionCache {
  key: string;
  store: AnchoredTextStore;
}

export interface ContentExtractor {
  /**
   * Extract embeddable/annotatable text, or decline with the class reason
   * (scanned-without-OCR, encrypted, corrupt). The caller skips embedding
   * and settles skipped with that reason.
   */
  extract(content: Buffer, mediaType: string, cache?: ExtractionCache): Promise<ExtractedText | ExtractionDecline>;
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
