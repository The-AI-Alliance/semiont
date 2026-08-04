/**
 * `AnchoredTextStore` over `IContentTransport` — how an out-of-process
 * extraction seam reaches the one real store (PERSIST-ANCHORS P2c).
 *
 * Every cache consumer runs outside the backend — the smelter worker and the
 * detection workers — while the KnowledgeSystem owns the storage. This
 * adapter maps the store contract onto the transport's three
 * checksum-addressed calls, so `ExtractionCache { key, store }` works
 * identically in-process (LocalContentTransport → the store directly) and
 * over the wire (HttpContentTransport → the /anchored-text routes).
 *
 * It honors the store contract's failure rule — the cache may make things
 * faster, never make them fail: a read or list failure is a miss, a write
 * failure is swallowed (debug-logged). Callers that need a write to be LOUD
 * — the re-anchor path, whose artifact IS the job — use the transport's
 * `putAnchoredText` directly, not this adapter.
 */

import type { IContentTransport, Logger } from '@semiont/core';
import type { AnchoredTextStore } from './anchored-text-store';

export function anchoredTextStoreOverTransport(
  content: IContentTransport,
  logger?: Logger,
): AnchoredTextStore {
  return {
    async read(key) {
      try {
        return await content.getAnchoredTextByChecksum(key);
      } catch (error) {
        logger?.debug('Anchored-text cache: transport read failed — treating as miss', {
          key,
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    async write(key, outcome) {
      try {
        await content.putAnchoredText(key, outcome);
      } catch (error) {
        logger?.debug('Anchored-text cache: transport write failed — entry not stored', {
          key,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async list() {
      try {
        return await content.listAnchoredTextKeys();
      } catch (error) {
        logger?.debug('Anchored-text cache: transport list failed — treating as empty', {
          reason: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
  };
}
