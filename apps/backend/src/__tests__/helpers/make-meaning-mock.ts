/**
 * Shared MakeMeaningService mock factory for backend tests.
 *
 * Provides a structurally-verified stub so the compiler catches shape
 * mismatches at the factory rather than at every call site.
 *
 * Usage:
 *   startMakeMeaning: vi.fn().mockResolvedValue(makeMeaningMock())
 *   startMakeMeaning: vi.fn().mockResolvedValue(makeMeaningMock({ jobQueue: myMockJobQueue }))
 */

import { vi } from 'vitest';
import type {
  MakeMeaningService,
  KnowledgeSystem,
} from '@semiont/make-meaning';
import type { KnowledgeBase } from '@semiont/make-meaning';
import type { JobQueue } from '@semiont/jobs';

// ─── Leaf stubs ───────────────────────────────────────────────────────────────

export function stubKnowledgeBase(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    eventStore:     { appendEvent: vi.fn() } as unknown as KnowledgeBase['eventStore'],
    views:          {} as KnowledgeBase['views'],
    content:        { store: vi.fn(), retrieve: vi.fn() } as unknown as KnowledgeBase['content'],
    graph:          {} as KnowledgeBase['graph'],
    graphConsumer:  { stop: vi.fn().mockResolvedValue(undefined) } as unknown as KnowledgeBase['graphConsumer'],
    projectionsDir: '',
    ...overrides,
  };
}

export function stubKnowledgeSystem(kbOverrides: Partial<KnowledgeBase> = {}): KnowledgeSystem {
  return {
    kb:                stubKnowledgeBase(kbOverrides),
    stower:            {} as KnowledgeSystem['stower'],
    gatherer:          {} as KnowledgeSystem['gatherer'],
    matcher:           {} as KnowledgeSystem['matcher'],
    browser:           { stop: vi.fn().mockResolvedValue(undefined) } as unknown as KnowledgeSystem['browser'],
    cloneTokenManager: {} as KnowledgeSystem['cloneTokenManager'],
    stop:              vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Service stub ─────────────────────────────────────────────────────────────

export function makeMeaningMock(overrides: Partial<MakeMeaningService> = {}): MakeMeaningService {
  return {
    knowledgeSystem: stubKnowledgeSystem(),
    jobQueue:        { createJob: vi.fn(), getJob: vi.fn() } as unknown as JobQueue,
    workers:         {} as MakeMeaningService['workers'],
    stop:            vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
