import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import type { components } from '@semiont/core';
import { createYieldStateUnit } from '../yield-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import { resourceContextFor, annotationContextFor } from '../../../__tests__/fixtures/gathered-context';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';
import type { YieldGenerationEvent } from '../../../namespaces/types';

type JobProgress = components['schemas']['JobProgress'];
type JobCompleteCommand = components['schemas']['JobCompleteCommand'];

const progressEvent = (p: JobProgress): YieldGenerationEvent => ({ kind: 'progress', data: p });

const completeEvent = (result?: JobCompleteCommand['result']): YieldGenerationEvent => ({
  kind: 'complete',
  data: {
    resourceId: 'res-1',
    jobId: 'job-1',
    jobType: 'generation',
    ...(result ? { result } : {}),
  },
});

const GEN_RESULT: JobCompleteCommand['result'] = {
  kind: 'generation',
  resourceId: 'res-new-1',
  resourceName: 'Summary of PB',
  truncated: false,
};

// fromContext derives every id FROM the focus — the state unit passes the
// context through untouched, so these fixtures are the whole identity story.
const CTX_ANN = annotationContextFor('res-1', 'ref-ann-1');
const CTX_RES = resourceContextFor('res-1');

function makeProgress(overrides: Partial<JobProgress> = {}): JobProgress {
  return { percentage: 50, ...overrides };
}

function withYield(fromContextFn: ReturnType<typeof vi.fn>): TestClient {
  return makeTestClient({ yield: { fromContext: fromContextFn } });
}

// All lifecycle flows through the `client.yield.fromContext` Observable —
// yield-state-unit no longer subscribes to bus channels directly. Tests drive
// lifecycle by `next`/`complete`/`error`-ing the mocked Observable that
// `fromContext` returns.
describe('createYieldStateUnit', () => {
  let tc: TestClient;

  afterEach(() => { tc?.bus.destroy(); });

  it('initializes with not generating and null progress', () => {
    tc = withYield(vi.fn());
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));
    expect(gen).toEqual([false]);
    expect(prog).toEqual([null]);
    stateUnit.dispose();
  });

  it('generate() passes the context POSITIONALLY to client.yield.fromContext and defaults language to the locale', () => {
    const fromContextFn = vi.fn(() => new Observable(() => {}));
    tc = withYield(fromContextFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');

    stateUnit.generate(CTX_ANN, { title: 'Test', storageUri: 'store://test' });

    expect(fromContextFn).toHaveBeenCalledOnce();
    expect(fromContextFn).toHaveBeenCalledWith(
      CTX_ANN,
      expect.objectContaining({ title: 'Test', language: 'en' }),
    );
    stateUnit.dispose();
  });

  it('resource-focus contexts ride the same path — one generate, no second method', () => {
    const fromContextFn = vi.fn(() => new Observable(() => {}));
    tc = withYield(fromContextFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');

    stateUnit.generate(CTX_RES, { title: 'Test', storageUri: 'store://t' });

    expect(fromContextFn).toHaveBeenCalledOnce();
    expect(fromContextFn).toHaveBeenCalledWith(
      CTX_RES,
      expect.objectContaining({ title: 'Test', language: 'en' }),
    );
    stateUnit.dispose();
  });

  it('pipes Observable next into progress$ and flips isGenerating=true', () => {
    const p = makeProgress({ percentage: 25 });
    const fromContextFn = vi.fn(() => new Observable<YieldGenerationEvent>((sub) => {
      sub.next(progressEvent(p));
    }));
    tc = withYield(fromContextFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));

    stateUnit.generate(CTX_ANN, { title: 'T', storageUri: 's' });
    expect(prog).toEqual([null, p]);
    expect(gen[gen.length - 1]).toBe(true);
    stateUnit.dispose();
  });

  it('handles multiple next emissions in sequence', () => {
    const progressSubject = new Subject<YieldGenerationEvent>();
    const fromContextFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(fromContextFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const prog: unknown[] = [];
    stateUnit.progress$.subscribe(v => prog.push(v));

    stateUnit.generate(CTX_ANN, { title: 'T', storageUri: 's' });

    const p1 = makeProgress({ percentage: 30 });
    const p2 = makeProgress({ percentage: 60 });
    progressSubject.next(progressEvent(p1));
    progressSubject.next(progressEvent(p2));
    expect(prog).toEqual([null, p1, p2]);
    stateUnit.dispose();
  });

  it('flips isGenerating=false on complete and KEEPS the finished display', () => {
    vi.useFakeTimers();
    const progressSubject = new Subject<YieldGenerationEvent>();
    const fromContextFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(fromContextFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));

    stateUnit.generate(CTX_ANN, { title: 'T', storageUri: 's' });
    progressSubject.next(progressEvent(makeProgress({ percentage: 75 })));
    progressSubject.complete();

    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).not.toBeNull();

    // CLEAN-PROGRESS D1: no 2 s timer, and no 5 s one either — the two flows
    // had different endings in the same component. Dismissal is explicit.
    vi.advanceTimersByTime(60_000);
    expect(prog[prog.length - 1]).not.toBeNull();

    stateUnit.dismissProgress();
    expect(prog[prog.length - 1]).toBeNull();

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('clears progress and stops generating on Observable error', () => {
    const fromContextFn = vi.fn(() => new Observable<YieldGenerationEvent>((sub) => {
      sub.next(progressEvent(makeProgress({ percentage: 40 })));
      sub.error(new Error('Generation failed'));
    }));
    tc = withYield(fromContextFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));

    stateUnit.generate(CTX_ANN, { title: 'T', storageUri: 's' });

    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).toBeNull();
    stateUnit.dispose();
  });

  // The unit's own 300s timer is GONE (FLOW-LIFECYCLE-CONVERGENCE A1): the
  // one stall guard lives in `runGeneration`'s producer, so it cannot be
  // exercised through this file's mocked `fromContext`. Its behavior — stall
  // → server-side cancel → typed error → display cleared — is pinned at the
  // stream level in `namespaces/__tests__/generation-stall.test.ts`,
  // including the unit's drive path over the REAL namespace.

  // ── The outcome (GENERATE-FROM-RESOURCE P2, D8) ─────────────────────────────
  // The link's fields come from `job:complete` — the broadcast, after citations
  // attach — which the driven stream already delivers as its `complete`-kind
  // event. The unit holds them so the terminal frame can render a link long
  // after the event has passed.

  it('outcome$ starts null and stays null through progress', () => {
    const progressSubject = new Subject<YieldGenerationEvent>();
    tc = withYield(vi.fn(() => progressSubject.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate(CTX_RES, { title: 'T', storageUri: 's' });
    progressSubject.next(progressEvent(makeProgress({ percentage: 95 })));

    expect(out.every(v => v === null)).toBe(true);
    stateUnit.dispose();
  });

  it('outcome$ emits the generation result from the stream complete event', () => {
    const progressSubject = new Subject<YieldGenerationEvent>();
    tc = withYield(vi.fn(() => progressSubject.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate(CTX_RES, { title: 'Summary of PB', storageUri: 's' });
    progressSubject.next(completeEvent(GEN_RESULT));
    progressSubject.complete();

    expect(out.at(-1)).toEqual({ resourceId: 'res-new-1', resourceName: 'Summary of PB' });
    stateUnit.dispose();
  });

  it('a complete event without a generation result leaves outcome$ null', () => {
    const progressSubject = new Subject<YieldGenerationEvent>();
    tc = withYield(vi.fn(() => progressSubject.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate(CTX_RES, { title: 'T', storageUri: 's' });
    progressSubject.next(completeEvent());
    progressSubject.complete();

    expect(out.at(-1)).toBeNull();
    stateUnit.dispose();
  });

  it('dismissProgress clears the outcome with the frame that displayed it', () => {
    const progressSubject = new Subject<YieldGenerationEvent>();
    tc = withYield(vi.fn(() => progressSubject.asObservable()));
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate(CTX_RES, { title: 'T', storageUri: 's' });
    progressSubject.next(completeEvent(GEN_RESULT));
    progressSubject.complete();
    expect(out.at(-1)).not.toBeNull();

    stateUnit.dismissProgress();
    expect(out.at(-1)).toBeNull();
    stateUnit.dispose();
  });

  it('a new generate() clears the previous outcome', () => {
    const first = new Subject<YieldGenerationEvent>();
    const second = new Subject<YieldGenerationEvent>();
    const fromContextFn = vi.fn()
      .mockReturnValueOnce(first.asObservable())
      .mockReturnValueOnce(second.asObservable());
    tc = withYield(fromContextFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const out: unknown[] = [];
    stateUnit.outcome$.subscribe(v => out.push(v));

    stateUnit.generate(CTX_RES, { title: 'T', storageUri: 's' });
    first.next(completeEvent(GEN_RESULT));
    first.complete();
    expect(out.at(-1)).not.toBeNull();

    stateUnit.generate(CTX_RES, { title: 'T2', storageUri: 's2' });
    expect(out.at(-1)).toBeNull();
    stateUnit.dispose();
  });

  it('stops responding after dispose', () => {
    const progressSubject = new Subject<YieldGenerationEvent>();
    const fromContextFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(fromContextFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));

    stateUnit.generate(CTX_ANN, { title: 'T', storageUri: 's' });
    stateUnit.dispose();

    // Any subsequent emission should not update post-dispose state
    progressSubject.next(progressEvent(makeProgress()));
    // The BehaviorSubject completed on dispose; no new emissions from it.
    expect(gen.at(-1)).toBe(false);  // last seen was the dispose teardown
  });
});

describe('YieldStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    const opts = { title: 'T', storageUri: 'file://x' };
    // Backend stub errors synchronously: drive()'s error path runs (no throw) and
    // the timeout() timer is cleared on the sync error, so no timers leak across runs.
    const stub = () => new Observable((s) => s.error(new Error('axiom-stub')));
    assertStateUnitAxioms({
      setup: () => {
        const tc = makeTestClient({ yield: { fromContext: vi.fn(stub) } });
        return { unit: createYieldStateUnit(tc.client, 'en'), teardown: () => tc.bus.destroy() };
      },
      surfaces: (u) => [u.isGenerating$, u.progress$, u.outcome$],
      invocations: (u) => [() => u.generate(CTX_ANN, opts), () => u.generate(CTX_RES, opts)],
      numRuns: 15,
    });
  });
});
