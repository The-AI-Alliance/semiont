/**
 * Read a resource's derived coordinate map, with the read-your-writes barrier.
 *
 * Shared deliberately. Two callers reach this — the Browser actor serving
 * `browse:anchored-text-requested` over the wire, and `LocalContentTransport`
 * serving an in-process client — and if they applied the barrier differently,
 * local and hosted modes would give different answers to the same question at
 * the same moment. That divergence is invisible until someone debugs it.
 *
 * **This never invokes the engine.** The Smelter is the sole producer. A miss
 * that survives the barrier answers `null`, and the caller degrades: for a PDF
 * annotation that means geometry with no quoted text, which is what shipped
 * before any of this existed. OCR in a request path is the thing this design
 * exists to avoid.
 */

import { getPrimaryRepresentation, resourceId as makeResourceId, type AnchoredText } from '@semiont/core';
import type { KnowledgeBase } from './knowledge-base';
import { SmeltProgressTimeout } from './smelt-progress';

/**
 * How long to wait for the Smelter to settle the content generation the caller
 * holds. Bounded: past this the honest answer is "not yet", and a viewer must
 * not block on it.
 */
export const ANCHORED_TEXT_SETTLE_TIMEOUT_MS = 15_000;

export async function readAnchoredText(kb: KnowledgeBase, resourceId: string): Promise<AnchoredText | null> {
  const hit = await kb.anchoredText.read(resourceId);
  if (hit) return hit;   // the common case pays for no settle check

  // A caller can arrive before the Smelter has finished the resource it just
  // uploaded. Answering "no map" for a document that is merely still being read
  // would be wrong, so wait for *this* content generation — keyed by checksum,
  // not by "some settle happened".
  const view = await kb.views.get(makeResourceId(resourceId));
  const checksum = getPrimaryRepresentation(view?.resource)?.checksum;
  if (!checksum) return null;

  try {
    const outcome = await kb.smeltProgress.whenSettled(resourceId, checksum, ANCHORED_TEXT_SETTLE_TIMEOUT_MS);
    // 'skipped' is a decision, not a delay: the document declined extraction and
    // will never have a map, so re-reading would be pointless.
    return outcome === 'indexed' ? kb.anchoredText.read(resourceId) : null;
  } catch (error) {
    // Only the barrier's own timeout degrades to "not yet". Anything else is a
    // broken progress fold and must surface rather than masquerade as "no map".
    if (error instanceof SmeltProgressTimeout) return null;
    throw error;
  }
}
