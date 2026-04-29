import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { resourceId as makeResourceId } from '@semiont/core';
import { createMarkStateUnit } from '../mark-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';

const RID = makeResourceId('res-1');

function withMark(overrides: Partial<{
  annotation: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  assist: ReturnType<typeof vi.fn>;
}> = {}): TestClient {
  return makeTestClient({
    mark: {
      annotation: overrides.annotation ?? vi.fn().mockResolvedValue({ annotationId: 'ann-new' }),
      delete: overrides.delete ?? vi.fn().mockResolvedValue(undefined),
      assist: overrides.assist ?? vi.fn(() => new Observable(() => {})),
    },
  });
}

describe('createMarkStateUnit', () => {
  let tc: TestClient;

  afterEach(() => { tc?.bus.destroy(); });

  it('initializes with null pending, null motivation, null progress', () => {
    tc = withMark();
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const pend: unknown[] = [];
    const motiv: unknown[] = [];
    const prog: unknown[] = [];
    stateUnit.pendingAnnotation$.subscribe(v => pend.push(v));
    stateUnit.assistingMotivation$.subscribe(v => motiv.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));
    expect(pend).toEqual([null]);
    expect(motiv).toEqual([null]);
    expect(prog).toEqual([null]);
    stateUnit.dispose();
  });

  // ── Pending annotation ──────────────────────────────────────

  it('sets pendingAnnotation on mark:requested', () => {
    tc = withMark();
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const pend: unknown[] = [];
    stateUnit.pendingAnnotation$.subscribe(v => pend.push(v));

    tc.bus.get('mark:requested').next({
      selector: { type: 'TextQuoteSelector', exact: 'hello' },
      motivation: 'highlighting',
    } as any);
    expect(pend[pend.length - 1]).toEqual({
      selector: { type: 'TextQuoteSelector', exact: 'hello' },
      motivation: 'highlighting',
    });
    stateUnit.dispose();
  });

  it('sets pendingAnnotation from mark:select-comment with selector conversion', () => {
    tc = withMark();
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const pend: unknown[] = [];
    stateUnit.pendingAnnotation$.subscribe(v => pend.push(v));

    tc.bus.get('mark:select-comment').next({ exact: 'text', prefix: 'pre', suffix: 'suf' } as any);
    const last = pend[pend.length - 1] as any;
    expect(last.motivation).toBe('commenting');
    expect(last.selector).toEqual({ type: 'TextQuoteSelector', exact: 'text', prefix: 'pre', suffix: 'suf' });
    stateUnit.dispose();
  });

  it('does not emit panel:open on mark:requested (view layer handles panel)', () => {
    // The view component is responsible for opening the annotations panel
    // in response to `pendingAnnotation$` — the state unit stays pure state, and
    // `panel:open` lives on the app-scoped (SemiontBrowser) bus anyway,
    // which this session-scoped client doesn't reach.
    tc = withMark();
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const panels: string[] = [];
    tc.bus.get('panel:open').subscribe(e => panels.push(e.panel));

    tc.bus.get('mark:requested').next({ selector: {}, motivation: 'highlighting' } as any);
    expect(panels).toEqual([]);
    stateUnit.dispose();
  });

  it('clears pendingAnnotation on mark:cancel-pending', () => {
    tc = withMark();
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const pend: unknown[] = [];
    stateUnit.pendingAnnotation$.subscribe(v => pend.push(v));

    tc.bus.get('mark:requested').next({ selector: {}, motivation: 'highlighting' } as any);
    tc.bus.get('mark:cancel-pending').next(undefined);
    expect(pend[pend.length - 1]).toBeNull();
    stateUnit.dispose();
  });

  it('clears pendingAnnotation on mark:create-ok', () => {
    tc = withMark();
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const pend: unknown[] = [];
    stateUnit.pendingAnnotation$.subscribe(v => pend.push(v));

    tc.bus.get('mark:requested').next({ selector: {}, motivation: 'highlighting' } as any);
    tc.bus.get('mark:create-ok').next({ annotationId: 'ann-1' });
    expect(pend[pend.length - 1]).toBeNull();
    stateUnit.dispose();
  });

  // ── CRUD bridging ──────────────────────────────────────────

  it('bridges mark:submit to client.mark.annotation', async () => {
    const annotationFn = vi.fn().mockResolvedValue({ annotationId: 'ann-new' });
    tc = withMark({ annotation: annotationFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const okEvents: unknown[] = [];
    tc.bus.get('mark:create-ok').subscribe(e => okEvents.push(e));

    tc.bus.get('mark:submit').next({
      motivation: 'highlighting',
      selector: { type: 'TextQuoteSelector', exact: 'test' },
      body: [{ type: 'TextualBody', value: 'note' }],
    } as any);

    await vi.waitFor(() => expect(annotationFn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(okEvents).toHaveLength(1));
    stateUnit.dispose();
  });

  it('emits mark:create-failed when submit errors', async () => {
    const annotationFn = vi.fn().mockRejectedValue(new Error('Network error'));
    tc = withMark({ annotation: annotationFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const failures: unknown[] = [];
    tc.bus.get('mark:create-failed').subscribe(e => failures.push(e));

    tc.bus.get('mark:submit').next({
      motivation: 'highlighting',
      selector: { type: 'TextQuoteSelector', exact: 'x' },
    } as any);

    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toEqual(expect.objectContaining({ message: 'Network error' }));
    stateUnit.dispose();
  });

  it('bridges mark:delete to client.mark.delete', async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    tc = withMark({ delete: deleteFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const okEvents: unknown[] = [];
    tc.bus.get('mark:delete-ok').subscribe(e => okEvents.push(e));

    tc.bus.get('mark:delete').next({ annotationId: 'ann-del' } as any);

    await vi.waitFor(() => expect(deleteFn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(okEvents).toHaveLength(1));
    stateUnit.dispose();
  });

  // ── AI assist ──────────────────────────────────────────────

  it('sets assistingMotivation on mark:assist-request', () => {
    tc = withMark();
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const motiv: unknown[] = [];
    stateUnit.assistingMotivation$.subscribe(v => motiv.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    expect(motiv[motiv.length - 1]).toBe('highlighting');
    stateUnit.dispose();
  });

  it('pipes Observable next into progress$', () => {
    const progressSubject = new Subject();
    const assistFn = vi.fn(() => progressSubject.asObservable());
    tc = withMark({ assist: assistFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const prog: unknown[] = [];
    stateUnit.progress$.subscribe(v => prog.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    progressSubject.next({ kind: 'progress', data: { stage: 'analyzing', percentage: 42, message: 'working' } });
    expect(prog[prog.length - 1]).toEqual({ stage: 'analyzing', percentage: 42, message: 'working' });
    stateUnit.dispose();
  });

  it('clears assistingMotivation on Observable complete', () => {
    const progressSubject = new Subject();
    const assistFn = vi.fn(() => progressSubject.asObservable());
    tc = withMark({ assist: assistFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const motiv: unknown[] = [];
    stateUnit.assistingMotivation$.subscribe(v => motiv.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    expect(motiv[motiv.length - 1]).toBe('highlighting');
    progressSubject.complete();
    expect(motiv[motiv.length - 1]).toBeNull();
    stateUnit.dispose();
  });

  it('clears all assist state on Observable error', () => {
    const progressSubject = new Subject();
    const assistFn = vi.fn(() => progressSubject.asObservable());
    tc = withMark({ assist: assistFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const motiv: unknown[] = [];
    const prog: unknown[] = [];
    stateUnit.assistingMotivation$.subscribe(v => motiv.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    progressSubject.next({ kind: 'progress', data: { stage: 'x', percentage: 50, message: 'm' } });
    progressSubject.error(new Error('LLM error'));

    expect(motiv[motiv.length - 1]).toBeNull();
    expect(prog[prog.length - 1]).toBeNull();
    stateUnit.dispose();
  });

  it('clears progress on mark:progress-dismiss', () => {
    const progressSubject = new Subject();
    const assistFn = vi.fn(() => progressSubject.asObservable());
    tc = withMark({ assist: assistFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const prog: unknown[] = [];
    stateUnit.progress$.subscribe(v => prog.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    progressSubject.next({ kind: 'progress', data: { stage: 'x', percentage: 50, message: 'm' } });
    tc.bus.get('mark:progress-dismiss').next(undefined);
    expect(prog[prog.length - 1]).toBeNull();
    stateUnit.dispose();
  });

  it('dismisses progress 5s after Observable complete', () => {
    vi.useFakeTimers();
    const progressSubject = new Subject();
    const assistFn = vi.fn(() => progressSubject.asObservable());
    tc = withMark({ assist: assistFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const prog: unknown[] = [];
    stateUnit.progress$.subscribe(v => prog.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    progressSubject.next({ kind: 'progress', data: { stage: 'x', percentage: 50, message: 'm' } });
    progressSubject.complete();

    expect(prog[prog.length - 1]).not.toBeNull();
    vi.advanceTimersByTime(5000);
    expect(prog[prog.length - 1]).toBeNull();

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('clears state when assist Observable errors immediately', () => {
    const assistFn = vi.fn(() => new Observable((sub) => {
      sub.error(new Error('LLM down'));
    }));
    tc = withMark({ assist: assistFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const motiv: unknown[] = [];
    stateUnit.assistingMotivation$.subscribe(v => motiv.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    expect(motiv[motiv.length - 1]).toBeNull();
    stateUnit.dispose();
  });

  it('times out a silent assist Observable after 180s', () => {
    vi.useFakeTimers();
    const assistFn = vi.fn(() => new Observable(() => {}));
    tc = withMark({ assist: assistFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const motiv: unknown[] = [];
    stateUnit.assistingMotivation$.subscribe(v => motiv.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    expect(motiv[motiv.length - 1]).toBe('highlighting');

    vi.advanceTimersByTime(180_000);
    expect(motiv[motiv.length - 1]).toBeNull();

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('resets timeout on each progress emission (does not fire prematurely)', () => {
    vi.useFakeTimers();
    const progressSubject = new Subject();
    const assistFn = vi.fn(() => progressSubject.asObservable());
    tc = withMark({ assist: assistFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const motiv: unknown[] = [];
    stateUnit.assistingMotivation$.subscribe(v => motiv.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    expect(motiv[motiv.length - 1]).toBe('highlighting');

    vi.advanceTimersByTime(170_000);
    progressSubject.next({ kind: 'progress', data: { stage: 'analyzing', percentage: 50, message: 'm' } });

    vi.advanceTimersByTime(170_000);
    expect(motiv[motiv.length - 1]).toBe('highlighting');

    vi.advanceTimersByTime(10_000);
    expect(motiv[motiv.length - 1]).toBeNull();

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('stops responding after dispose', () => {
    const annotationFn = vi.fn();
    tc = withMark({ annotation: annotationFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    stateUnit.dispose();

    tc.bus.get('mark:submit').next({ motivation: 'highlighting', selector: {} } as any);
    expect(annotationFn).not.toHaveBeenCalled();
  });
});
