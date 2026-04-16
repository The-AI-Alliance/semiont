import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Observable } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { YieldProgress } from '@semiont/core';
import type { SemiontApiClient } from '../../../client';
import { createYieldVM } from '../yield-vm';

const RID = makeResourceId('res-1');
const REF_ID = 'ref-ann-1';

function makeProgress(overrides: Partial<YieldProgress> = {}): YieldProgress {
  return { status: 'generating', referenceId: REF_ID, percentage: 50, message: 'Working...', ...overrides };
}

function mockClient(fromAnnotationFn: ReturnType<typeof vi.fn>): SemiontApiClient {
  return { yield: { fromAnnotation: fromAnnotationFn } } as unknown as SemiontApiClient;
}

describe('createYieldVM', () => {
  let eventBus: EventBus;

  beforeEach(() => { eventBus = new EventBus(); });
  afterEach(() => { eventBus.destroy(); });

  it('initializes with not generating and null progress', () => {
    const vm = createYieldVM(mockClient(vi.fn()), eventBus, RID, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    vm.progress$.subscribe(v => prog.push(v));
    expect(gen).toEqual([false]);
    expect(prog).toEqual([null]);
    vm.dispose();
  });

  it('sets isGenerating and progress on yield:progress', () => {
    const vm = createYieldVM(mockClient(vi.fn()), eventBus, RID, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    vm.progress$.subscribe(v => prog.push(v));

    const p = makeProgress({ percentage: 30 });
    eventBus.get('yield:progress').next(p);
    expect(gen).toEqual([false, true]);
    expect(prog).toEqual([null, p]);
    vm.dispose();
  });

  it('updates progress on subsequent yield:progress events', () => {
    const vm = createYieldVM(mockClient(vi.fn()), eventBus, RID, 'en');
    const prog: unknown[] = [];
    vm.progress$.subscribe(v => prog.push(v));

    const p1 = makeProgress({ percentage: 30 });
    const p2 = makeProgress({ percentage: 60 });
    eventBus.get('yield:progress').next(p1);
    eventBus.get('yield:progress').next(p2);
    expect(prog).toEqual([null, p1, p2]);
    vm.dispose();
  });

  it('sets isGenerating=false and updates progress on yield:finished', () => {
    vi.useFakeTimers();
    const vm = createYieldVM(mockClient(vi.fn()), eventBus, RID, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    vm.progress$.subscribe(v => prog.push(v));

    eventBus.get('yield:progress').next(makeProgress({ percentage: 75 }));
    const final = makeProgress({ status: 'complete', percentage: 100 });
    eventBus.get('yield:finished').next(final);

    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).toEqual(final);

    vi.advanceTimersByTime(2000);
    expect(prog[prog.length - 1]).toBeNull();

    vm.dispose();
    vi.useRealTimers();
  });

  it('clears progress and stops generating on yield:failed', () => {
    const vm = createYieldVM(mockClient(vi.fn()), eventBus, RID, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    vm.progress$.subscribe(v => prog.push(v));

    eventBus.get('yield:progress').next(makeProgress({ percentage: 40 }));
    eventBus.get('yield:failed').next({ error: 'Generation failed' });

    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).toBeNull();
    vm.dispose();
  });

  it('handles yield:finished without prior progress', () => {
    const vm = createYieldVM(mockClient(vi.fn()), eventBus, RID, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    vm.progress$.subscribe(v => prog.push(v));

    const final = makeProgress({ status: 'complete', percentage: 100 });
    eventBus.get('yield:finished').next(final);

    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).toEqual(final);
    vm.dispose();
  });

  it('handles yield:failed without prior progress', () => {
    const vm = createYieldVM(mockClient(vi.fn()), eventBus, RID, 'en');
    const gen: boolean[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));

    eventBus.get('yield:failed').next({ error: 'Unexpected' });
    expect(gen[gen.length - 1]).toBe(false);
    vm.dispose();
  });

  it('generate() calls client.yield.fromAnnotation', () => {
    const fromAnnotationFn = vi.fn(() => new Observable(() => {}));
    const vm = createYieldVM(mockClient(fromAnnotationFn), eventBus, RID, 'en');

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

  it('generate() updates progress from the Observable', () => {
    const p = makeProgress({ percentage: 25 });
    const fromAnnotationFn = vi.fn(() => new Observable((sub) => {
      sub.next(p);
    }));
    const vm = createYieldVM(mockClient(fromAnnotationFn), eventBus, RID, 'en');
    const prog: unknown[] = [];
    vm.progress$.subscribe(v => prog.push(v));

    vm.generate(REF_ID, { title: 'T', storageUri: 's', context: {} as any });
    expect(prog).toEqual([null, p]);
    vm.dispose();
  });

  it('generate() clears state and emits yield:failed on Observable error', () => {
    const fromAnnotationFn = vi.fn(() => new Observable((sub) => {
      sub.error(new Error('LLM timeout'));
    }));
    const vm = createYieldVM(mockClient(fromAnnotationFn), eventBus, RID, 'en');
    const gen: boolean[] = [];
    const failures: unknown[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    eventBus.get('yield:failed').subscribe(f => failures.push(f));

    vm.generate(REF_ID, { title: 'T', storageUri: 's', context: {} as any });
    expect(gen[gen.length - 1]).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual(expect.objectContaining({ error: 'LLM timeout' }));
    vm.dispose();
  });

  it('stops responding after dispose', () => {
    const vm = createYieldVM(mockClient(vi.fn()), eventBus, RID, 'en');
    const gen: boolean[] = [];
    vm.isGenerating$.subscribe(v => gen.push(v));
    vm.dispose();

    eventBus.get('yield:progress').next(makeProgress());
    expect(gen).toEqual([false]);
  });
});
