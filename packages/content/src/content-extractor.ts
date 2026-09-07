/**
 * ContentExtractor — DERIVING text from bytes that carry none of their own.
 *
 * Scope note (READ-VS-EXTRACT P2): this file used to hold a strategy-keyed
 * registry covering both ways a resource yields text — decoding (charset-aware
 * `Buffer → string`) and deriving (parse a PDF, OCR it when there is no text
 * layer). Those share a name and almost nothing else: microseconds vs. minutes,
 * total determinism vs. none across engine versions, no canonical artifact vs.
 * exactly one, and anyone-with-bytes vs. the Smelter alone. The registry made
 * them interchangeable at every call site.
 *
 * Decoding left: it is `decodeRepresentation` in `@semiont/core`, called
 * directly. What remains here is the deriving half, reached through
 * `derivingExtractorFor` and callable only with the store that persists its
 * output.
 *
 * Anchoring is unaffected: annotations anchor to native geometry (`items`),
 * never to extracted-text offsets, so re-derivation can never break an anchor.
 */

import { yieldsGeometryOf, type PdfTextItem } from '@semiont/core';
import type { AnchoredTextStore } from './anchored-text-store';
import { pdfExtractor } from './pdf-extractor';

export interface ExtractedText {
  /** Discriminant — mirrors the wire member (WIRE-UNION-DISCRIMINANTS P5c/D6). */
  kind: 'extracted';
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
  /** Discriminant — mirrors the wire member (WIRE-UNION-DISCRIMINANTS P5c/D6). */
  kind: 'declined';
  declined: 'no-text-layer' | 'encrypted' | 'corrupt' | 'too-large';
}

/**
 * Where a strategy may reuse an earlier recognition, and under what key.
 *
 * The caller supplies the key, and derives it from the bytes it actually
 * holds — `calculateChecksum` over the same Buffer it passes to `extract()` —
 * never from a descriptor's claim. A catalog-derived key can race a byte
 * change (bytes fetched at one moment, descriptor read at another) and file
 * or read geometry under an identity that does not describe the bytes being
 * extracted. The write path made recompute-over-claim the rule
 * (PERSIST-ANCHORS P1b); readers mirror it (P1c). One SHA-256 over bytes
 * already in memory is noise against the engine pass a hit avoids.
 *
 * REQUIRED, and that is the ownership rule (READ-VS-EXTRACT P2). It carries an
 * `AnchoredTextStore`, and only the Smelter holds one — so deriving is reachable
 * exactly to the process that can persist what it derived. The restriction is a
 * capability the caller must already hold, not a convention it must remember:
 * a would-be second producer cannot construct the argument, so it cannot compile.
 *
 * The seam is `extract()` itself (PERSIST-ANCHORS D1/P2b): a hit returns the
 * FINISHED outcome — classification, geometry, provenance, or a named decline —
 * so neither the native parse nor the engine runs.
 */
export interface ExtractionCache {
  key: string;
  store: AnchoredTextStore;
}

/**
 * Whether a strategy's extractions carry positioned runs lives in
 * `@semiont/core`'s `yieldsGeometryOf`, NOT here (READ-VS-EXTRACT P1). It is a
 * property of the strategy, and the strategy vocabulary is core's — declaring it
 * per-implementation made it two facts that could disagree, and forced consumers
 * asking about a media type to resolve an implementation to find out.
 * `content-extractor.test.ts` gates core's answer against what these extractors
 * actually produce.
 */
export interface ContentExtractor {
  /**
   * Derive text WITH geometry from bytes that carry no text of their own, or
   * decline with the class reason (scanned-without-OCR, encrypted, corrupt).
   * The caller skips embedding and settles skipped with that reason.
   *
   * Expensive, non-deterministic across engine versions, and the sole producer
   * of a canonical artifact — which is why `cache` is required rather than
   * optional (see `ExtractionCache`).
   */
  extract(content: Buffer, mediaType: string, cache: ExtractionCache): Promise<ExtractedText | ExtractionDecline>;
}

/**
 * The deriving extractor for a media type, or `null` when its text needs no
 * deriving.
 *
 * **This replaced a `Record<TextExtraction, ContentExtractor | null>` keyed by
 * strategy (READ-VS-EXTRACT P2), and the deletion is the point.** That map held
 * one real extractor, a `null`, and — under 'decode' — a one-line wrapper around
 * core's `decodeRepresentation`, which five sites in `@semiont/make-meaning`
 * already called directly. Resolving "give me an extractor for this media type"
 * therefore returned, half the time, a trivial function dressed as the same
 * capability as OCR: identical at the call site, wildly different in cost,
 * determinism, and who is allowed to run it. That symmetry is what let a
 * detection worker OCR scanned PDFs for four months without anyone reading it as
 * a category error (#739).
 *
 * Decoding is now a direct `decodeRepresentation()` call at the two sites that
 * need it. There is no registry to resolve, so there is no way to reach OCR by
 * asking a generic question — and a caller that gets a non-null answer here still
 * cannot run it without an `AnchoredTextStore`.
 *
 * Keyed by P1's `yieldsGeometryOf`, so this and the Smelter's publish gate cannot
 * disagree about which media types have a canonical artifact.
 */
export function derivingExtractorFor(mediaType: string): ContentExtractor | null {
  return yieldsGeometryOf(mediaType) ? pdfExtractor : null;
}
