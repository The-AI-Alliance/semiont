import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { resourceId as makeResourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import { createYieldVM } from '../yield-vm';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import type { YieldGenerationEvent } from '../../../namespaces/types';

type JobProgress = components['schemas']['JobProgress'];

const progressEvent = (p: JobProgress): YieldGenerationEvent => ({ kind: 'progress', data: p });

const RID = makeResourceId('res-1');
const REF_ID = 'ref-ann-1';

function makeProgress(overrides: Partial<JobProgress> = {}): JobProgress {
  return { stage: 'generating', percentage: 50, message: 'Working...', ...overrides };
}

function withYield(fromAnnotationFn: ReturnType<typeof vi.fn>): TestClient {
  return makeTestClient({ yield: { fromAnnotation: fromAnnotationFn } });
}

// All lifecycle now flows through the `client.yield.fromAnnotation`
// Observable — yield-vm no longer subscribes to bus channels directly.
// Tests drive lifecycle by `next`/`complete`/`error`-ing the mocked
// Observable that `fromAnnotation` returns.
describe('createYieldVM', () => {
  let tc: TestClient;

  afterEach(() => { tc?.bus.destroy(); });

  it('initializes with not generating and null progress', () => {
    tc = withYield(vi.fn());
    const vm = createYieldVM(tc.client, RID, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    vm.progress$.subscribe(v => prog.push(v));
    expect(gen).toEqual([false]);
    expect(prog).toEqual([null]);
    vm.dispose();
  });

  it('generate() calls client.yield.fromAnnotation', () => {
    const fromAnnotationFn = vi.fn(() => new Observable(() => {}));
    tc = withYield(fromAnnotationFn);
    const vm = createYieldVM(tc.client, RID, 'en');

    vm.generate(REF_ID, {
      title: 'Test',
      storageUri: 'store://test',
      context: { annotation: {} } as any,
    });

    expect(fromAnnotationFn).toHaveBeenCalledOnce();
    expect(fromAnnotationFn).toHaveBeenCalledWith(
      RID,
      expect.any(String),
      expect.objectContaining({ title: 'Test', language: 'en' }),
    );
    vm.dispose();
  });

  it('pipes Observable next into progress$ and flips isGenerating=true', () => {
    const p = makeProgress({ percentage: 25 });
    const fromAnnotationFn = vi.fn(() => new Observable<YieldGenerationEvent>((sub) => {
      sub.next(progressEvent(p));
    }));
    tc = withYield(fromAnnotationFn);
    const vm = createYieldVM(tc.client, RID, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    vm.progress$.subscribe(v => prog.push(v));

    vm.generate(REF_ID, { title: 'T', storageUri: 's', context: {} as any });
    expect(prog).toEqual([null, p]);
    expect(gen[gen.length - 1]).toBe(true);
    vm.dispose();
  });

  it('handles multiple next emissions in sequence', () => {
    const progressSubject = new Subject<YieldGenerationEvent>();
    const fromAnnotationFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(fromAnnotationFn);
    const vm = createYieldVM(tc.client, RID, 'en');
    const prog: unknown[] = [];
    vm.progress$.subscribe(v => prog.push(v));

    vm.generate(REF_ID, { title: 'T', storageUri: 's', context: {} as any });

    const p1 = makeProgress({ percentage: 30 });
    const p2 = makeProgress({ percentage: 60 });
    progressSubject.next(progressEvent(p1));
    progressSubject.next(progressEvent(p2));
    expect(prog).toEqual([null, p1, p2]);
    vm.dispose();
  });

  it('flips isGenerating=false on Observable complete and dismisses progress after 2s', () => {
    vi.useFakeTimers();
    const progressSubject = new Subject<YieldGenerationEvent>();
    const fromAnnotationFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(fromAnnotationFn);
    const vm = createYieldVM(tc.client, RID, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    vm.progress$.subscribe(v => prog.push(v));

    vm.generate(REF_ID, { title: 'T', storageUri: 's', context: {} as any });
    progressSubject.next(progressEvent(makeProgress({ percentage: 75 })));
    progressSubject.complete();

    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).not.toBeNull();

    vi.advanceTimersByTime(2000);
    expect(prog[prog.length - 1]).toBeNull();

    vm.dispose();
    vi.useRealTimers();
  });

  it('clears progress and stops generating on Observable error', () => {
    const fromAnnotationFn = vi.fn(() => new Observable<YieldGenerationEvent>((sub) => {
      sub.next(progressEvent(makeProgress({ percentage: 40 })));
      sub.error(new Error('Generation failed'));
    }));
    tc = withYield(fromAnnotationFn);
    const vm = createYieldVM(tc.client, RID, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    vm.progress$.subscribe(v => prog.push(v));

    vm.generate(REF_ID, { title: 'T', storageUri: 's', context: {} as any });

    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).toBeNull();
    vm.dispose();
  });

  it('times out a silent Observable after 300s (no progress within window)', () => {
    vi.useFakeTimers();
    const fromAnnotationFn = vi.fn(() => new Observable(() => {}));
    tc = withYield(fromAnnotationFn);
    const vm = createYieldVM(tc.client, RID, 'en');
    const gen: boolean[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));

    vm.generate(REF_ID, { title: 'T', storageUri: 's', context: {} as any });
    expect(gen[gen.length - 1]).toBe(false);  // no progress yet → not flipped to true

    vi.advanceTimersByTime(300_000);
    // Timeout fires → Observable errors → state stays clear
    expect(gen[gen.length - 1]).toBe(false);

    vm.dispose();
    vi.useRealTimers();
  });

  it('resets timeout on each progress emission', () => {
    vi.useFakeTimers();
    const progressSubject = new Subject<YieldGenerationEvent>();
    const fromAnnotationFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(fromAnnotationFn);
    const vm = createYieldVM(tc.client, RID, 'en');
    const gen: boolean[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));

    vm.generate(REF_ID, { title: 'T', storageUri: 's', context: {} as any });

    vi.advanceTimersByTime(290_000);
    progressSubject.next(progressEvent(makeProgress({ percentage: 50 })));

    // 290s after last progress — still within 300s window
    vi.advanceTimersByTime(290_000);
    expect(gen[gen.length - 1]).toBe(true);

    // 300s after last progress — timeout
    vi.advanceTimersByTime(10_000);
    expect(gen[gen.length - 1]).toBe(false);

    vm.dispose();
    vi.useRealTimers();
  });

  it('stops responding after dispose', () => {
    const progressSubject = new Subject<YieldGenerationEvent>();
    const fromAnnotationFn = vi.fn(() => progressSubject.asObservable());
    tc = withYield(fromAnnotationFn);
    const vm = createYieldVM(tc.client, RID, 'en');
    const gen: boolean[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));

    vm.generate(REF_ID, { title: 'T', storageUri: 's', context: {} as any });
    vm.dispose();

    // Any subsequent emission should not update post-dispose state
    progressSubject.next(progressEvent(makeProgress()));
    // The BehaviorSubject completed on dispose; no new emissions from it.
    expect(gen.at(-1)).toBe(false);  // last seen was the dispose teardown
  });
});
