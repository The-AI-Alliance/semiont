/**
 * Identifier utilities for event sourcing
 */

import { createHash } from 'crypto';
import { annotationId, type AnnotationId } from '@semiont/core';

/** The identity of an annotation — everything that makes it that annotation
 *  and nothing else (JOB-RESTART-SAFETY P3, HD1). */
export interface AnnotationIdentity {
  /** The resource the annotation is about. */
  resourceId: string;
  /** W3C motivation: two motivations on one span are two annotations. */
  motivation: string;
  /**
   * The span, rendered by whichever builder anchored it. Deliberately a
   * caller-supplied STRING rather than a structured span: text anchors by
   * character offset and PDF by page geometry, so there is no shape both
   * share, and inventing one here would be a third home for a fact the
   * builders already own.
   */
  anchor: string;
  /**
   * The annotation's body, when it has one.
   *
   * Included for EVERY motivation that carries one, which — measured
   * 2026-09-03 — is every motivation except `highlighting`. HD1 anticipated
   * this only for `commenting`, but the same collision exists for `assessing`
   * and `tagging` (two assessments of one span differ solely by their text),
   * and for `linking`: a detected reference carries its entity type as an
   * unresolved TextualBody, which is exactly the "type" HD1's input set names.
   * So the per-motivation table HD1 asked for collapses to one rule — hash the
   * body whenever there is one — and that is better than a table, because a
   * sixth motivation inherits the right behavior instead of an omission.
   */
  body?: unknown;
}

/**
 * Canonical JSON: object keys sorted at every depth, so a body built by one
 * code path hashes the same as an equivalent body built by another. Array
 * order is preserved — it is meaningful (a tagging body is [category, schema]).
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The annotation's id, derived from what the annotation IS.
 *
 * This is what makes every recovery path in JOB-RESTART-SAFETY idempotent: a
 * re-queued job, a resumed unit and a retried failure all re-emit the same
 * annotation, and re-emitting it is now a no-op *with no read* — which is the
 * property a read-before-write could not provide, because the thing it would
 * read is exactly what is down when recovery is happening (HD1).
 *
 * Note what is NOT an input: `created`, the emitting worker, the job id, any
 * counter. A recovery re-emits at a different time from a different process
 * and must still collide, so anything about the emission rather than the
 * annotation would defeat the whole mechanism.
 *
 * 21 base64url characters of a SHA-256 — the same length the `nanoid(21)` this
 * replaces produced, so nothing downstream that sized a column or a URL around
 * it changes, and ~126 bits, which is far more than a per-resource span space
 * needs.
 */
export function annotationIdFor(identity: AnnotationIdentity): AnnotationId {
  const material = canonical({
    resourceId: identity.resourceId,
    motivation: identity.motivation,
    anchor: identity.anchor,
    ...(identity.body !== undefined ? { body: identity.body } : {}),
  });
  const digest = createHash('sha256').update(material, 'utf8').digest('base64url');
  return annotationId(digest.slice(0, 21));
}
