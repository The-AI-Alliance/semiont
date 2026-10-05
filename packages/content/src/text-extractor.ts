/**
 * TextExtractor — DERIVING text from bytes that carry none of their own.
 *
 * Scope note: a resource yields text in two ways — decoding (charset-aware
 * `Buffer → string`) and deriving (parse a PDF, OCR it when there is no text
 * layer). They share a name and almost nothing else: microseconds vs. minutes,
 * total determinism vs. none across engine versions, no canonical artifact vs.
 * exactly one, and anyone-with-bytes vs. the Smelter alone. One registry over
 * both would make them interchangeable at every call site, so there is none.
 *
 * Decoding is `decodeRepresentation` in `@semiont/core`, called directly. This
 * file is the deriving half, reached through `derivingExtractorFor` and
 * callable only with the store that persists its output.
 *
 * Anchoring never depends on the derived text: annotations anchor to native
 * geometry (`items`), never to extracted-text offsets, so re-derivation can
 * never break an anchor.
 */

import { yieldsGeometryOf, type PdfTextItem } from '@semiont/core';
import type { AnchoredTextStore } from './anchored-text-store';
import { pdfExtractor } from './pdf-extractor';

export interface ExtractedText {
  /** Discriminant — mirrors `ExtractionOutcome`'s wire member. */
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
 * could not name its class).
 */
export interface ExtractionDecline {
  /** Discriminant — mirrors `ExtractionOutcome`'s wire member; `declined` is its detail. */
  kind: 'declined';
  declined: 'no-text-layer' | 'encrypted' | 'corrupt' | 'too-large';
}

/**
 * Where a derivation may reuse a stored recognition, and under what key.
 *
 * The caller supplies the key, and derives it from the bytes it actually
 * holds — `calculateChecksum` over the same Buffer it passes to `extract()` —
 * never from a descriptor's claim. A catalog-derived key can race a byte
 * change (bytes fetched at one moment, descriptor read at another) and file
 * or read geometry under an identity that does not describe the bytes being
 * extracted. Recompute-over-claim is the write path's rule; readers
 * mirror it. One SHA-256 over bytes already in memory is noise against the
 * engine pass a hit avoids.
 *
 * REQUIRED, and that is the ownership rule. It carries an `AnchoredTextStore`,
 * and only the Smelter holds one — so deriving is reachable exactly to the
 * process that can persist what it derived. The restriction is a capability the
 * caller must already hold, not a convention it must remember: a would-be
 * second producer cannot construct the argument, so it cannot compile.
 *
 * The seam is `extract()` itself: a hit returns the FINISHED outcome —
 * classification, geometry, provenance, or a named decline — so neither the
 * native parse nor the engine runs.
 */
export interface ExtractionCache {
  key: string;
  store: AnchoredTextStore;
}

/**
 * Deriving text from bytes that carry none of their own.
 *
 * Named for what it produces — TEXT, by deriving, the only thing "extraction"
 * means here — not for its input. WHERE a media type's text comes from at all
 * is core's `TextSource`, which spans both routes and is therefore not called
 * extraction.
 *
 * Whether a text source yields positioned runs lives in `@semiont/core`'s
 * `yieldsGeometryOf`, NOT here. It is a property of the source, and that
 * vocabulary is core's — declared per-implementation it would be two facts that
 * could disagree, and consumers asking about a media type would have to resolve
 * an implementation to find out. `text-extractor.test.ts` gates core's answer
 * against what these extractors actually produce.
 */
export interface TextExtractor {
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
 * **Deliberately not a `Record<TextSource, TextExtractor | null>` keyed by
 * strategy.** Such a map would hold, under 'decode', a one-line wrapper around
 * core's `decodeRepresentation`, so resolving "give me an extractor for this
 * media type" would return, half the time, a trivial function dressed as the
 * same capability as OCR: identical at the call site, wildly different in cost,
 * determinism, and who is allowed to run it. Under that symmetry a detection
 * worker OCRing scanned PDFs does not read as a category error.
 *
 * Decoding is a direct `decodeRepresentation()` call at the sites that need
 * it. There is no registry to resolve, so there is no way to reach OCR by
 * asking a generic question — and a caller that gets a non-null answer here still
 * cannot run it without an `AnchoredTextStore`.
 *
 * Keyed by core's `yieldsGeometryOf`, so this and the Smelter's publish gate
 * cannot disagree about which media types have a canonical artifact.
 */
export function derivingExtractorFor(mediaType: string): TextExtractor | null {
  return yieldsGeometryOf(mediaType) ? pdfExtractor : null;
}
