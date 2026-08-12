import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import type { components } from '@semiont/core';
import { createYieldStateUnit } from '../yield-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import { resourceContextFor, annotationContextFor } from '../../../__tests__/fixtures/gathered-context';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';
import type { YieldGenerationEvent } from '../../../namespaces/types';

type JobProgress = components['schemas']['JobProgress'];

const progressEvent = (p: JobProgress): YieldGenerationEvent => ({ kind: 'progress', data: p });

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

  it('flips isGenerating=false on Observable complete and dismisses progress after 2s', () => {
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

    vi.advanceTimersByTime(2000);
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

  it('times out a silent Observable after 300s (no progress within window)', () => {
    vi.useFakeTimers();
    const fromContextFn = vi.fn(() => new Observable(() => {}));
    tc = withYield(fromContextFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));

    stateUnit.generate(CTX_ANN, { title: 'T', storageUri: 's' });
    expect(gen[gen.length - 1]).toBe(false);  // no progress yet → not flipped to true

    vi.advanceTimersByTime(300_000);
    // Timeout fires → Observable errors → state stays clear
    expect(gen[gen.length - 1]).toBe(false);

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('resets timeout on each progress emission', () => {
    vi.useFakeTimers();
    const progressSubject = new Subject<YieldGenerationEvent>();
    const fromContextFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(fromContextFn);
    const stateUnit = createYieldStateUnit(tc.client, 'en');
    const gen: boolean[] = [];
    stateUnit.isGenerating$.subscribe(v => gen.push(v));

    stateUnit.generate(CTX_ANN, { title: 'T', storageUri: 's' });

    vi.advanceTimersByTime(290_000);
    progressSubject.next(progressEvent(makeProgress({ percentage: 50 })));

    // 290s after last progress — still within 300s window
    vi.advanceTimersByTime(290_000);
    expect(gen[gen.length - 1]).toBe(true);

    // 300s after last progress — timeout
    vi.advanceTimersByTime(10_000);
    expect(gen[gen.length - 1]).toBe(false);

    stateUnit.dispose();
    vi.useRealTimers();
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
      surfaces: (u) => [u.isGenerating$, u.progress$],
      invocations: (u) => [() => u.generate(CTX_ANN, opts), () => u.generate(CTX_RES, opts)],
      numRuns: 15,
    });
  });
});
