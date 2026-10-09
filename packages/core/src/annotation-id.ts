/**
 * The id of an annotation a builder makes: worked out from what the
 * annotation is, never minted. specs/src/annotations/id-cases.json holds the
 * rule, for this and for every other implementation.
 *
 * The builders (`annotation-builders.ts`) are its callers, and no one else
 * is: it is no part of what `@semiont/core` or `@semiont/sdk` exports.
 */

import { base64url } from './base64url';
import { annotationId, type AnnotationId } from './identifiers';
import { sha256 } from './sha256';

/** The identity of an annotation — everything that makes it that annotation
 *  and nothing else: the inputs its content-addressed id is hashed from. */
export interface AnnotationIdentity {
  /** The resource the annotation is about. */
  resourceId: string;
  /** W3C motivation: two motivations on one span are two annotations. */
  motivation: string;
  /**
   * The span, rendered by the builder that anchored it. Deliberately a
   * caller-supplied STRING rather than a structured span: text anchors by
   * character offset and PDF by page geometry, so there is no shape both
   * share, and inventing one here would be a third home for a fact the
   * builders already own. An annotation of a resource as a whole is anchored
   * nowhere on it, and its anchor is the empty string.
   */
  anchor: string;
  /**
   * The annotation's body, when it has one.
   *
   * Included for EVERY motivation that carries one, which is every
   * motivation except `highlighting`. The body matters beyond `commenting`:
   * the same collision exists for `assessing` and `tagging` (two assessments
   * of one span differ solely by their text), and for `linking`: a detected
   * reference carries its entity
   * type as an unresolved TextualBody, which is exactly the "type" in the
   * identity a detected annotation needs (resource, span, type, motivation).
   * So a per-motivation table of hash inputs collapses to one rule — hash the
   * body whenever there is one — and that is better than a table, because a
   * sixth motivation inherits the right behavior instead of an omission.
   */
  body?: unknown;
}

/**
 * The order of two names by code point, which is the order the id's rule
 * states (specs/src/annotations/id-cases.json). A string compares by UTF-16
 * code unit, and that is another order: it puts a name with a character
 * outside the Basic Multilingual Plane before one with a character from
 * U+E000 to U+FFFF.
 */
function byCodePoint(a: string, b: string): number {
  const [left, right] = [Array.from(a), Array.from(b)];
  for (let i = 0; i < left.length && i < right.length; i++) {
    const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * Canonical JSON: an object's members in the order of their names by code
 * point, at every depth, so a body built by one code path hashes the same as
 * an equivalent body built by another, in any language. Array order is
 * preserved — it is meaningful (a tagging body is [category, schema]).
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => byCodePoint(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The annotation's id, derived from what the annotation IS.
 *
 * This is what makes every job-recovery path idempotent: a
 * re-queued job, a resumed unit and a retried failure all re-emit the same
 * annotation, and re-emitting it is a no-op *with no read* — which is the
 * property a read-before-write could not provide, because the thing it would
 * read is exactly what is down when recovery is happening.
 *
 * Note what is NOT an input: `created`, the emitting worker, the job id, any
 * counter. A recovery re-emits at a different time from a different process
 * and must still collide, so anything about the emission rather than the
 * annotation would defeat the whole mechanism.
 *
 * 21 base64url characters of a SHA-256: ~126 bits, which is far more than a
 * per-resource span space needs.
 *
 * ## The no-op guarantee is conditional on `anchor`, and the two kinds of span differ
 *
 * "Re-emitting is a no-op" holds exactly as far as `anchor` is stable, and that
 * is the builder's property, not this function's. `annotationOfSpan` does not
 * have it equally for its two kinds of span:
 *
 * - **A span of a text** is anchored as `${start}:${end}:${exact}` and the
 *   annotation STORES those offsets in a `TextPositionSelector`. Identity depends
 *   only on fields the annotation carries, so the guarantee is unconditional and
 *   any reader can verify it after the fact.
 * - **A span of a PDF's anchored text** is anchored the same way, but the offsets
 *   come from a text layer *derived* per attempt and are deliberately NOT stored —
 *   the annotation carries page geometry and the quoted text instead. There the
 *   guarantee holds only while that derivation is stable, and a reader holding two
 *   annotations cannot tell whether they disagree because they are different facts
 *   or because the text layer moved: every stored field would be identical.
 *
 * The derivation is cached per content checksum, but the entry is gated by a stamp
 * over `@semiont/content`'s version plus the PDF engine and its traineddata, and
 * that stamp is deliberately over-eager — **a release busts it and the same bytes
 * are re-extracted by different code.** So the honest statement is: the PDF path's
 * guarantee holds *per stamp generation*, and a release is the event that could end
 * one. The offsets are stable across the pdfjs 6.2.108 → 6.3.289 engine move
 * (1,192 pages), and `pdf-offset-stability.test.ts` is what keeps that from
 * being a one-time observation. The OCR path has not been measured.
 */
export function annotationIdFor(identity: AnnotationIdentity): AnnotationId {
  const material = canonical({
    resourceId: identity.resourceId,
    motivation: identity.motivation,
    anchor: identity.anchor,
    ...(identity.body !== undefined ? { body: identity.body } : {}),
  });
  const digest = base64url(sha256(new TextEncoder().encode(material)));
  return annotationId(digest.slice(0, 21));
}
