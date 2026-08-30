/**
 * `AnchoredTextStore` over the bus — how the detection workers consult the
 * one real store now that the Smelter owns it (ANCHORED-TEXT-TO-SMELTER D2).
 *
 * This replaces `anchoredTextStoreOverTransport`, which mapped the store
 * contract onto three HTTP routes on the gateway. Those routes are going
 * away; what remains is a single checksum-addressed bus operation, answered
 * by the Archivist, and it is READ-ONLY by design:
 *
 * - **Read is the whole point.** A hit means the worker skips extraction —
 *   for a scanned PDF, that is an OCR pass not run.
 * - **Write is not this process's business.** The Smelter is the sole writer
 *   of anchored text, and there is no write operation on the wire to reach
 *   for. A worker that misses extracts locally and *discards*: it needs
 *   `extracted.items` in-process regardless, so the only thing lost is
 *   sharing the result with a later pass — and the Smelter's reconcile fills
 *   the store for every geometry-capable resource anyway, so a miss means
 *   detection beat the Smelter to a fresh upload.
 *
 * The no-op `write` is the store contract's own sanctioned shape — *"a store
 * that cannot write is still a store"* — not a swallowed failure. Do not
 * "complete" it by wiring a write: single-writer is the property that
 * replaced the deleted agent gate.
 */

import type { AnchoredTextStore } from '@semiont/content';
import type { ExtractionOutcome, Logger } from '@semiont/core';

/** Just the consult — the worker needs no other part of the client here. */
interface ChecksumConsult {
  browse: { anchoredTextByChecksum(checksum: string): Promise<ExtractionOutcome | null> };
}

export function anchoredTextOverBus(client: ChecksumConsult, logger?: Logger): AnchoredTextStore {
  return {
    async read(key) {
      try {
        return await client.browse.anchoredTextByChecksum(key);
      } catch (error) {
        // The cache may make things faster, never make them fail: an
        // unanswered consult is a miss, and the caller extracts.
        logger?.debug('Anchored-text consult failed — treating as miss', {
          key,
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    async write(key) {
      logger?.debug('Anchored-text write skipped — the Smelter is the sole writer', { key });
    },

    async list() {
      // Only the Smelter's reconcile planner lists this store, and it holds
      // the real one locally. A worker never asks.
      return [];
    },
  };
}
