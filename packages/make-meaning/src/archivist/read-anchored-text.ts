/**
 * Read a resource's derived coordinate map, with the read-your-writes barrier.
 *
 * One caller reaches this: the Browser actor serving
 * `browse:anchored-text-requested`. Every reader asks on that channel — over
 * the wire, or in-process beside the Browser — so local and hosted modes
 * apply one barrier and give the same answer to the same question at the
 * same moment.
 *
 * **This never invokes the engine.** The Smelter is the sole producer. A miss
 * that survives the barrier answers a named absence (`not-yet` or `no-map`),
 * and the caller degrades: for a PDF annotation that means geometry with no
 * quoted text. OCR in a request path is the thing this design exists to
 * avoid.
 */

import { getPrimaryRepresentation, type AnchoredTextAnswer, type ResourceId } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';
import type { AnchoredTextStore } from '@semiont/content';
import { SmeltProgressTimeout, type SmeltProgress } from '../smelt-progress';

/** The barrier-guarded read path's whole surface. */
export interface AnchoredTextReads {
  views: Pick<ViewStorage, 'get'>;
  anchoredText: Pick<AnchoredTextStore, 'read'>;
  smeltProgress: Pick<SmeltProgress, 'whenSettled'>;
}

/**
 * How long to wait for the Smelter to settle the content generation the caller
 * holds. Bounded: past this the honest answer is "not yet", and a viewer must
 * not block on it.
 */
export const ANCHORED_TEXT_SETTLE_TIMEOUT_MS = 15_000;

/**
 * A resource's coordinate map, a stored decline, or a NAMED absence.
 *
 * Never null. A bare `null` would cover four facts — the settle barrier
 * expired, the Smelter settled the resource as skipped, there is no content
 * identity, or the progress fold was disposed — two of which a caller should
 * retry and two of which are terminal. A reader that blocks on this
 * (detection consults it for a geometry-bearing type's text, fetching no bytes
 * and running no OCR of its own) cannot classify its own failure without the
 * distinction: it would retry forever on a document that will never have a map,
 * or fail terminally on one that is merely still being read.
 *
 * `settleTimeoutMs` is a parameter rather than the constant it defaults to so
 * tests can drive the barrier without waiting out a 15 s production budget.
 */
export async function readAnchoredText(
  kb: AnchoredTextReads,
  resourceId: ResourceId,
  settleTimeoutMs: number = ANCHORED_TEXT_SETTLE_TIMEOUT_MS,
): Promise<AnchoredTextAnswer> {
  // The `resourceId → checksum` index: the store is keyed by content
  // identity, the caller holds a mutable pointer, and the index — a live view
  // read — resolves the pointer first, on EVERY read, hits included. That is
  // the measured price of the checksum key; what it buys is that a reader can
  // never receive geometry for bytes the resource no longer has. A resource
  // the view doesn't know, or one without a representation checksum, has no
  // content identity to look up — no map, by construction.
  const view = await kb.views.get(resourceId);
  const checksum = getPrimaryRepresentation(view?.resource)?.checksum;
  // No content identity — the resource is unknown here, or its primary
  // representation carries no checksum. Nothing to key the store by and nothing
  // to wait for, which is a different fact from "the map is coming".
  if (!checksum) return { kind: 'unknown' };

  const hit = await kb.anchoredText.read(checksum);
  if (hit) return hit;   // the common case still pays for no settle check

  // A caller can arrive before the Smelter has finished the resource it just
  // uploaded. Answering "no map" for a document that is merely still being read
  // would be wrong, so wait for *this* content generation — keyed by the same
  // checksum the artifact is filed under.
  try {
    const outcome = await kb.smeltProgress.whenSettled(resourceId, checksum, settleTimeoutMs);
    // 'skipped' is a decision, not a delay: this media type derives no geometry,
    // so a map will never exist and waiting again is pointless. 'inert' means
    // the fold was disposed — the process cannot answer, which is temporary.
    if (outcome === 'skipped') return { kind: 'no-map' };
    if (outcome === 'inert') return { kind: 'not-yet' };

    // Settled indexed. The artifact should be here; if it is not, the reconcile
    // planner's third drift class has it (a lost entry, which it re-publishes),
    // so this is "come back", never "never".
    return (await kb.anchoredText.read(checksum)) ?? { kind: 'not-yet' };
  } catch (error) {
    // Only the barrier's own timeout is "not yet". Anything else is a broken
    // progress fold and must surface rather than masquerade as an absence.
    if (error instanceof SmeltProgressTimeout) return { kind: 'not-yet' };
    throw error;
  }
}
