import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { SemiontApiClient } from '../../../client';
import { createMarkVM } from '../mark-vm';

const RID = makeResourceId('res-1');

function mockClient(overrides: Partial<{
  annotation: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  assist: ReturnType<typeof vi.fn>;
}> = {}): SemiontApiClient {
  return {
    mark: {
      annotation: overrides.annotation ?? vi.fn().mockResolvedValue({ annotationId: 'ann-new' }),
      delete: overrides.delete ?? vi.fn().mockResolvedValue(undefined),
      assist: overrides.assist ?? vi.fn(() => new Observable(() => {})),
    },
  } as unknown as SemiontApiClient;
}

describe('createMarkVM', () => {
  let eventBus: EventBus;

  beforeEach(() => { eventBus = new EventBus(); });
  afterEach(() => { eventBus.destroy(); });

  it('initializes with null pending, null motivation, null progress', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const pend: unknown[] = [];
    const motiv: unknown[] = [];
    const prog: unknown[] = [];
    vm.pendingAnnotation$.subscribe(v => pend.push(v));
    vm.assistingMotivation$.subscribe(v => motiv.push(v));
    vm.progress$.subscribe(v => prog.push(v));
    expect(pend).toEqual([null]);
    expect(motiv).toEqual([null]);
    expect(prog).toEqual([null]);
    vm.dispose();
  });

  // ── Pending annotation ──────────────────────────────────────

  it('sets pendingAnnotation on mark:requested', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const pend: unknown[] = [];
    vm.pendingAnnotation$.subscribe(v => pend.push(v));

    eventBus.get('mark:requested').next({
      selector: { type: 'TextQuoteSelector', exact: 'hello' },
      motivation: 'highlighting',
    } as any);
    expect(pend[pend.length - 1]).toEqual({
      selector: { type: 'TextQuoteSelector', exact: 'hello' },
      motivation: 'highlighting',
    });
    vm.dispose();
  });

  it('sets pendingAnnotation from mark:select-comment with selector conversion', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const pend: unknown[] = [];
    vm.pendingAnnotation$.subscribe(v => pend.push(v));

    eventBus.get('mark:select-comment').next({ exact: 'text', prefix: 'pre', suffix: 'suf' } as any);
    const last = pend[pend.length - 1] as any;
    expect(last.motivation).toBe('commenting');
    expect(last.selector).toEqual({ type: 'TextQuoteSelector', exact: 'text', prefix: 'pre', suffix: 'suf' });
    vm.dispose();
  });

  it('opens annotations panel on mark:requested', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const panels: string[] = [];
    eventBus.get('browse:panel-open').subscribe(e => panels.push(e.panel));

    eventBus.get('mark:requested').next({ selector: {}, motivation: 'highlighting' } as any);
    expect(panels).toEqual(['annotations']);
    vm.dispose();
  });

  it('clears pendingAnnotation on mark:cancel-pending', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const pend: unknown[] = [];
    vm.pendingAnnotation$.subscribe(v => pend.push(v));

    eventBus.get('mark:requested').next({ selector: {}, motivation: 'highlighting' } as any);
    eventBus.get('mark:cancel-pending').next(undefined);
    expect(pend[pend.length - 1]).toBeNull();
    vm.dispose();
  });

  it('clears pendingAnnotation on mark:create-ok', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const pend: unknown[] = [];
    vm.pendingAnnotation$.subscribe(v => pend.push(v));

    eventBus.get('mark:requested').next({ selector: {}, motivation: 'highlighting' } as any);
    eventBus.get('mark:create-ok').next({ annotationId: 'ann-1' });
    expect(pend[pend.length - 1]).toBeNull();
    vm.dispose();
  });

  // ── CRUD bridging ──────────────────────────────────────────

  it('bridges mark:submit to client.mark.annotation', async () => {
    const annotationFn = vi.fn().mockResolvedValue({ annotationId: 'ann-new' });
    const vm = createMarkVM(mockClient({ annotation: annotationFn }), eventBus, RID);
    const okEvents: unknown[] = [];
    eventBus.get('mark:create-ok').subscribe(e => okEvents.push(e));

    eventBus.get('mark:submit').next({
      motivation: 'highlighting',
      selector: { type: 'TextQuoteSelector', exact: 'test' },
      body: [{ type: 'TextualBody', value: 'note' }],
    } as any);

    await vi.waitFor(() => expect(annotationFn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(okEvents).toHaveLength(1));
    vm.dispose();
  });

  it('emits mark:create-failed when submit errors', async () => {
    const annotationFn = vi.fn().mockRejectedValue(new Error('Network error'));
    const vm = createMarkVM(mockClient({ annotation: annotationFn }), eventBus, RID);
    const failures: unknown[] = [];
    eventBus.get('mark:create-failed').subscribe(e => failures.push(e));

    eventBus.get('mark:submit').next({
      motivation: 'highlighting',
      selector: { type: 'TextQuoteSelector', exact: 'x' },
      body: [],
    } as any);

    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toEqual(expect.objectContaining({ message: 'Network error' }));
    vm.dispose();
  });

  it('bridges mark:delete to client.mark.delete', async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    const vm = createMarkVM(mockClient({ delete: deleteFn }), eventBus, RID);
    const okEvents: unknown[] = [];
    eventBus.get('mark:delete-ok').subscribe(e => okEvents.push(e));

    eventBus.get('mark:delete').next({ annotationId: 'ann-del' } as any);

    await vi.waitFor(() => expect(deleteFn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(okEvents).toHaveLength(1));
    vm.dispose();
  });

  // ── AI assist ──────────────────────────────────────────────

  it('sets assistingMotivation on mark:assist-request', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const motiv: unknown[] = [];
    vm.assistingMotivation$.subscribe(v => motiv.push(v));

    eventBus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    expect(motiv[motiv.length - 1]).toBe('highlighting');
    vm.dispose();
  });

  it('updates progress on mark:progress', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const prog: unknown[] = [];
    vm.progress$.subscribe(v => prog.push(v));

    eventBus.get('mark:progress').next({ status: 'in-progress', percentage: 42 } as any);
    expect(prog[prog.length - 1]).toEqual({ status: 'in-progress', percentage: 42 });
    vm.dispose();
  });

  it('clears assistingMotivation on mark:assist-finished when motivation matches', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const motiv: unknown[] = [];
    vm.assistingMotivation$.subscribe(v => motiv.push(v));

    eventBus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    eventBus.get('mark:assist-finished').next({ motivation: 'highlighting' } as any);
    expect(motiv[motiv.length - 1]).toBeNull();
    vm.dispose();
  });

  it('keeps assistingMotivation on mark:assist-finished when motivation differs', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const motiv: unknown[] = [];
    vm.assistingMotivation$.subscribe(v => motiv.push(v));

    eventBus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    eventBus.get('mark:assist-finished').next({ motivation: 'commenting' } as any);
    expect(motiv[motiv.length - 1]).toBe('highlighting');
    vm.dispose();
  });

  it('clears all assist state on mark:assist-failed', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const motiv: unknown[] = [];
    const prog: unknown[] = [];
    vm.assistingMotivation$.subscribe(v => motiv.push(v));
    vm.progress$.subscribe(v => prog.push(v));

    eventBus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    eventBus.get('mark:progress').next({ status: 'x', percentage: 50 } as any);
    eventBus.get('mark:assist-failed').next({ message: 'LLM error' } as any);

    expect(motiv[motiv.length - 1]).toBeNull();
    expect(prog[prog.length - 1]).toBeNull();
    vm.dispose();
  });

  it('clears progress on mark:progress-dismiss', () => {
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const prog: unknown[] = [];
    vm.progress$.subscribe(v => prog.push(v));

    eventBus.get('mark:progress').next({ status: 'x', percentage: 50 } as any);
    eventBus.get('mark:progress-dismiss').next(undefined);
    expect(prog[prog.length - 1]).toBeNull();
    vm.dispose();
  });

  it('dismisses progress after 5s on mark:assist-finished', () => {
    vi.useFakeTimers();
    const vm = createMarkVM(mockClient(), eventBus, RID);
    const prog: unknown[] = [];
    vm.progress$.subscribe(v => prog.push(v));

    eventBus.get('mark:progress').next({ status: 'x', percentage: 50 } as any);
    eventBus.get('mark:assist-finished').next({ motivation: 'highlighting' } as any);

    expect(prog[prog.length - 1]).not.toBeNull();
    vi.advanceTimersByTime(5000);
    expect(prog[prog.length - 1]).toBeNull();

    vm.dispose();
    vi.useRealTimers();
  });

  it('emits mark:assist-failed on Observable error from assist', () => {
    const assistFn = vi.fn(() => new Observable((sub) => {
      sub.error(new Error('LLM down'));
    }));
    const vm = createMarkVM(mockClient({ assist: assistFn }), eventBus, RID);
    const failures: unknown[] = [];
    eventBus.get('mark:assist-failed').subscribe(e => failures.push(e));

    eventBus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual(expect.objectContaining({ message: 'LLM down' }));
    vm.dispose();
  });

  it('emits mark:assist-failed on timeout when no progress within 180s', () => {
    vi.useFakeTimers();
    const assistFn = vi.fn(() => new Observable(() => {}));
    const vm = createMarkVM(mockClient({ assist: assistFn }), eventBus, RID);
    const failures: unknown[] = [];
    eventBus.get('mark:assist-failed').subscribe(e => failures.push(e));

    eventBus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    expect(failures).toHaveLength(0);

    vi.advanceTimersByTime(180_000);
    expect(failures).toHaveLength(1);

    vm.dispose();
    vi.useRealTimers();
  });

  it('resets timeout on each progress emission (does not fire prematurely)', () => {
    vi.useFakeTimers();
    const progressSubject = new Subject();
    const assistFn = vi.fn(() => progressSubject.asObservable());
    const vm = createMarkVM(mockClient({ assist: assistFn }), eventBus, RID);
    const failures: unknown[] = [];
    eventBus.get('mark:assist-failed').subscribe(e => failures.push(e));

    eventBus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);

    // Progress at 170s — resets the 180s timer
    vi.advanceTimersByTime(170_000);
    progressSubject.next({ status: 'in-progress', percentage: 50 });

    // At 340s (170s after last progress) — still within 180s window
    vi.advanceTimersByTime(170_000);
    expect(failures).toHaveLength(0);

    // At 350s (180s after last progress) — should timeout
    vi.advanceTimersByTime(10_000);
    expect(failures).toHaveLength(1);

    vm.dispose();
    vi.useRealTimers();
  });

  it('stops responding after dispose', () => {
    const annotationFn = vi.fn();
    const vm = createMarkVM(mockClient({ annotation: annotationFn }), eventBus, RID);
    vm.dispose();

    eventBus.get('mark:submit').next({ motivation: 'highlighting', selector: {}, body: [] } as any);
    expect(annotationFn).not.toHaveBeenCalled();
  });
});
