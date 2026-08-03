/**
 * An in-memory `AnchoredTextStore` for tests that build a `KnowledgeBase` by
 * hand.
 *
 * `KnowledgeBase.anchoredText` is required, not optional: a KnowledgeSystem
 * without somewhere to keep derived coordinate maps is not a configuration we
 * support, so the type says so and fixtures supply a real implementation rather
 * than a null object. This one honours the contract — what is written comes
 * back — it simply does not outlive the process, which is all a fixture needs.
 */

import type { AnchoredText } from '@semiont/core';
import type { AnchoredTextStore } from '@semiont/content';

export function memoryAnchoredTextStore(): AnchoredTextStore {
  const maps = new Map<string, AnchoredText>();
  return {
    async read(key) { return maps.get(key) ?? null; },
    async write(key, anchored) { maps.set(key, anchored); },
  };
}
