/**
 * Shared mock factory for `startMakeMeaningGateway` in gateway tests.
 *
 * Provides a structurally-verified stub so the compiler catches shape
 * mismatches at the factory rather than at every call site.
 *
 * It returns `GatewayMakeMeaningService` — `{ jobQueue, state, stop }` — which
 * is what the gateway's composition root actually returns. It used to return
 * the MONOLITH's `MakeMeaningService`, supplying a `knowledgeSystem` (five
 * fabricated actors) and a `project` that the real function stopped returning
 * when the thin connector landed, while omitting the `state` it does return.
 *
 * Usage:
 *   startMakeMeaningGateway: vi.fn().mockResolvedValue(makeMeaningMock())
 *   startMakeMeaningGateway: vi.fn().mockResolvedValue(makeMeaningMock({ jobQueue: myMockJobQueue }))
 */

import { vi } from 'vitest';
import type { GatewayMakeMeaningService, KnowledgeBase } from '@semiont/make-meaning';
import { SemiontState } from '@semiont/core/node';
import type { JobQueue } from '@semiont/jobs';

// ─── Leaf stubs ───────────────────────────────────────────────────────────────

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

// ─── Service stub ─────────────────────────────────────────────────────────────

export function makeMeaningMock(
  overrides: Partial<GatewayMakeMeaningService> = {},
): GatewayMakeMeaningService {
  return {
    jobQueue: { createJob: vi.fn(), getJob: vi.fn() } as unknown as JobQueue,
    // A REAL SemiontState, not a stub: it takes `{ name }` and derives every
    // path, so there is nothing to fake and nothing to drift.
    state: new SemiontState({ name: 'test-kb' }),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
