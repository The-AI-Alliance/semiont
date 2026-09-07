import type { ResourceId, components, AnchoredTextAnswer } from '@semiont/core';
import { textExtractionOf, yieldsGeometryOf } from '@semiont/core';
import { EXTRACTORS, type ContentReads, type ExtractionDecline } from '@semiont/content';
import { buildTextAnnotation, buildPdfAnnotation, type BuildAnnotation } from '../../processors';
import { DeterministicJobError } from '../../failure-class';

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
  declined: ExtractionDecline['declined'] | 'no-extractor' | 'empty'
    // The three the CONSULT can report for a geometry-bearing type
    // (SMELTER-OWNS-OCR P2). `not-yet` is transient — the Smelter has not
    // settled this generation yet, and the retry finds the store warm.
    // `no-map` and `unknown` are terminal: the first is drift between
    // `yieldsGeometryOf` and the Smelter's skip decision (a geometry type it
    // declined to map), the second is a resource with no content identity.
    | 'not-yet' | 'no-map' | 'unknown';
};

/** How a detection job reads canonical geometry: the resource-addressed
 * consult (`browse.resourceAnchoredText`), injected as a narrow function so
 * this stays on the read seam and never holds a session. */
export type ConsultAnchoredText = (resourceId: ResourceId) => Promise<AnchoredTextAnswer>;

/**
 * For one detection job, resolve the text the model detects over and the
 * media-appropriate way to turn a detected span into a stored annotation.
 *
 * Extraction goes through the **same registry the Smelter embeds from**
 * (`EXTRACTORS`, keyed by the media-type registry's `TextExtraction`
 * strategy), so detection and embedding always read a resource identically —
 * but a geometry-bearing type (PDF) is CONSULTED for the Smelter's canonical
 * text rather than re-extracted here — the Smelter owns OCR
 * (SMELTER-OWNS-OCR).
 *
 * Bytes come from the injected `ContentReads` for NON-geometry types only;
 * geometry types take the injected `consult` seam instead. Both are narrow
 * read seams rather than the session — the read is all this ever wanted.
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
  consult: ConsultAnchoredText,
): Promise<DetectionSource> {
  const extractor = EXTRACTORS[textExtractionOf(mediaType)];
  if (!extractor) return { declined: 'no-extractor' };

  // The media type decides where the text comes from (SMELTER-OWNS-OCR).
  //
  // GEOMETRY-BEARING types (PDF, every class) get their text from the
  // Smelter's canonical anchored text, CONSULTED by resourceId — the Smelter
  // is the sole producer, and a second derivation here is a second producer
  // whose divergent offsets misanchor every annotation silently. The worker
  // fetches no bytes and runs no OCR: the consult carries the text and its
  // geometry. `yieldsGeometryOf` is core's, derived from the same media-type
  // strategy the Smelter reads to decide whether to publish, so the two cannot
  // drift about which resources have canonical text (READ-VS-EXTRACT P1).
  if (yieldsGeometryOf(mediaType)) {
    const answer = await consult(resourceId);
    switch (answer.kind) {
      case 'extracted': {
        if (!answer.text.trim()) return { declined: 'empty' };
        const anchored = { text: answer.text, items: answer.items ?? [] };
        return {
          text: answer.text,
          buildAnnotation: (motivation, match, body) =>
            buildPdfAnnotation(anchored, resourceId, userId, generator, motivation, match, body),
        };
      }
      // The Smelter's own decline (encrypted, corrupt) — passed through by name.
      case 'declined': return { declined: answer.declined };
      // Named absences: `not-yet` retries, the other two are terminal.
      case 'not-yet': return { declined: 'not-yet' };
      case 'no-map':  return { declined: 'no-map' };
      case 'unknown': return { declined: 'unknown' };
      default: {
        // `answer` narrows to `never` only while every member of
        // `AnchoredTextAnswer` is handled above. Widen the wire without
        // deciding retry-vs-terminal for the new member HERE and this stops
        // compiling — which is the whole point, because the alternative is
        // silent: control would fall out of this branch into the byte path
        // below and re-derive a geometry-bearing PDF locally, restoring the
        // second-producer bug this design exists to remove.
        //
        // Not dead code at runtime, either. The union crosses a process
        // boundary, so a worker running against a newer Smelter can receive a
        // kind it was never compiled with. Terminal rather than transient:
        // retrying cannot teach this build a member it does not have.
        const unhandled: never = answer;
        throw new DeterministicJobError(
          `Unhandled anchored-text answer for resource ${resourceId}: ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }

  // NON-GEOMETRY types (markdown, plain text) have no canonical artifact to
  // consult — the Smelter publishes nothing for them, so there is nothing to
  // diverge from. Decode the bytes directly; the text itself is the
  // coordinate system, anchored by character offset.
  const { data } = await content.getBinary(resourceId);
  const extracted = await extractor.extract(Buffer.from(data), mediaType);
  if (extracted.kind === 'declined') return extracted;
  if (!extracted.text.trim()) return { declined: 'empty' };

  return {
    text: extracted.text,
    buildAnnotation: (motivation, match, body) =>
      buildTextAnnotation(extracted.text, resourceId, userId, generator, motivation, match, body),
  };
}
