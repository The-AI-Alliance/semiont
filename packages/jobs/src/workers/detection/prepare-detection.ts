import type { ResourceId, components } from '@semiont/core';
import { textExtractionOf } from '@semiont/core';
import { EXTRACTORS, calculateChecksum, type AnchoredTextStore, type ContentReads, type ExtractionDecline } from '@semiont/content';
import { buildTextAnnotation, buildPdfAnnotation, type BuildAnnotation } from '../../processors';

type Agent = components['schemas']['Agent'];

/**
 * What a detection job needs to run, or why it cannot.
 *
 * The decline mirrors extraction's named-decline idiom — a reason, never a
 * `null` that cannot say what went wrong. This union is worker-internal
 * (its decline enum is wider than the wire's), so it narrows by `declined`
 * presence; the wire outcome it wraps discriminates by `kind`
 * (WIRE-UNION-DISCRIMINANTS P5c).
 */
export type DetectionSource =
  | { text: string; buildAnnotation: BuildAnnotation }
  | DetectionDecline;

/**
 * Why detection could not read a resource. Widens the extractor's own reasons
 * with the two only a *caller* can observe: no extractor exists for the media
 * type at all, and extraction succeeded but produced nothing. Same vocabulary
 * the Smelter reports on `smelt:settled`, so one resource declines identically
 * whichever verb asked.
 */
export type DetectionDecline = {
  declined: ExtractionDecline['declined'] | 'no-extractor' | 'empty';
};

/**
 * For one detection job, resolve the text the model detects over and the
 * media-appropriate way to turn a detected span into a stored annotation.
 *
 * Extraction goes through the **same registry the Smelter embeds from**
 * (`EXTRACTORS`, keyed by the media-type registry's `TextExtraction`
 * strategy), so detection and embedding always read a resource identically —
 * including scanned PDFs, which are read by OCR rather than declined.
 *
 * Bytes come from the injected `ContentReads` — in the fleet, the Archivist's
 * byte route rather than a hop through the gateway (SINGLE-KB-MOUNT P4). This
 * takes the read seam and not the session because the read is all it ever
 * wanted from one.
 *
 * The anchoring model follows the geometry, not the media type: an extraction
 * that carries positioned runs anchors spatially (page + viewrect), one that
 * does not anchors by character offset. Detection processors stay
 * media-agnostic — they take `.text` and the returned `buildAnnotation`, and
 * never see a layer or a media type.
 */
export async function prepareDetection(
  mediaType: string,
  content: ContentReads,
  resourceId: ResourceId,
  userId: string,
  generator: Agent,
  store: AnchoredTextStore,
): Promise<DetectionSource> {
  const extractor = EXTRACTORS[textExtractionOf(mediaType)];
  if (!extractor) return { declined: 'no-extractor' };

  const { data } = await content.getBinary(resourceId);
  // Read through the anchored-text cache (PERSIST-ANCHORS P2d): a stored
  // outcome — success or decline — is served whole, so a second detection
  // pass over the same representation runs neither parser nor engine. The
  // key is the checksum of the bytes actually fetched, never a descriptor
  // claim: a catalog-derived key can race a byte change and file or read
  // geometry under an identity that does not describe these bytes (P1c).
  const bytes = Buffer.from(data);
  const extracted = await extractor.extract(bytes, mediaType, {
    key: calculateChecksum(bytes),
    store,
  });
  if (extracted.kind === 'declined') return extracted;
  if (!extracted.text.trim()) return { declined: 'empty' };

  // Positioned runs mean the source has real geometry to anchor to — a PDF's
  // text layer, its form widgets, its table cells, or OCR'd words. Without
  // them the text itself is the coordinate system.
  const items = extracted.items;
  if (items && items.length > 0) {
    const anchored = { text: extracted.text, items };
    return {
      text: extracted.text,
      buildAnnotation: (motivation, match, body) =>
        buildPdfAnnotation(anchored, resourceId, userId, generator, motivation, match, body),
    };
  }

  return {
    text: extracted.text,
    buildAnnotation: (motivation, match, body) =>
      buildTextAnnotation(extracted.text, resourceId, userId, generator, motivation, match, body),
  };
}
