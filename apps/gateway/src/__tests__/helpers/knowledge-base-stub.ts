/**
 * A structurally-verified `KnowledgeBase` stub for gateway tests that need one
 * without standing up real graph/vector/event stores. The compiler catches
 * shape drift here rather than at every call site.
 *
 * (This file used to also mock `startMakeMeaningGateway`; that function left
 * with the gateway's job queue — EXTRACT-JOBS P2/P3 — and the gateway boot no
 * longer starts any make-meaning slice, so nothing needs mocking. Only the KB
 * stub, which one integration test still composes by hand, remains.)
 */

import { vi } from 'vitest';
import type { KnowledgeBase } from '@semiont/make-meaning';

function inMemoryAnchoredText(): KnowledgeBase['anchoredText'] {
  const maps = new Map<string, Awaited<ReturnType<KnowledgeBase['anchoredText']['read']>>>();
  return {
    read: async (key) => maps.get(key) ?? null,
    write: async (key, anchored) => { maps.set(key, anchored); },
    list: async () => [...maps.keys()],
  };
}

export function stubKnowledgeBase(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    eventStore:     { appendEvent: vi.fn() } as unknown as KnowledgeBase['eventStore'],
    views:          {} as KnowledgeBase['views'],
    content:        { store: vi.fn(), retrieve: vi.fn() } as unknown as KnowledgeBase['content'],
    graph:          {} as KnowledgeBase['graph'],
    // `anchoredText` is required, not optional: a KnowledgeSystem with nowhere
    // to keep derived coordinate maps is not a configuration we support. This
    // honours the contract — what is written comes back — it simply does not
    // outlive the test.
    anchoredText:   inMemoryAnchoredText(),
    vectors:        {} as KnowledgeBase['vectors'],
    weaveProgress: { dispose: vi.fn() } as unknown as KnowledgeBase['weaveProgress'],
    smeltProgress: { settledAt: vi.fn(), whenSettled: vi.fn(async () => 'inert' as const), dispose: vi.fn() } as unknown as KnowledgeBase['smeltProgress'],
    projectionsDir: '',
    ...overrides,
  };
}
