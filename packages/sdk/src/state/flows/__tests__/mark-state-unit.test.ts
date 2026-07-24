import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { resourceId as makeResourceId } from '@semiont/core';
import { createMarkStateUnit } from '../mark-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import { assertStateUnitAxioms } from '@semiont/core/testing';

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
      source: 'res-1',
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

    tc.bus.get('mark:requested').next({ source: 'res-1', selector: {}, motivation: 'highlighting' } as any);
    expect(panels).toEqual([]);
    stateUnit.dispose();
  });

  it('clears pendingAnnotation on mark:cancel-pending', () => {
    tc = withMark();
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const pend: unknown[] = [];
    stateUnit.pendingAnnotation$.subscribe(v => pend.push(v));

    tc.bus.get('mark:requested').next({ source: 'res-1', selector: {}, motivation: 'highlighting' } as any);
    tc.bus.get('mark:cancel-pending').next(undefined);
    expect(pend[pend.length - 1]).toBeNull();
    stateUnit.dispose();
  });

  it('clears pendingAnnotation on mark:create-ok', () => {
    tc = withMark();
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const pend: unknown[] = [];
    stateUnit.pendingAnnotation$.subscribe(v => pend.push(v));

    tc.bus.get('mark:requested').next({ source: 'res-1', selector: {}, motivation: 'highlighting' } as any);
    tc.bus.get('mark:create-ok').next({ response: { annotationId: 'ann-1' } });
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
      source: 'res-1',
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
      source: 'res-1',
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

  it('surfaces a clean decline (scanned PDF) as a progress message and keeps it up (no auto-dismiss)', () => {
    // #738: a scanned/image-only PDF declines cleanly — the worker reports a
    // no-text-layer result rather than erroring. It must surface as a message so
    // the user learns why nothing was detected, and persist until dismissed.
    vi.useFakeTimers();
    const progressSubject = new Subject();
    tc = withMark({ assist: vi.fn(() => progressSubject.asObservable()) });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const prog: unknown[] = [];
    stateUnit.progress$.subscribe(v => prog.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    progressSubject.next({
      kind: 'complete',
      data: { result: { declined: true, reason: 'no-text-layer', message: 'This PDF has no extractable text layer (scanned or image-only); detection is not supported.' } },
    });
    progressSubject.complete();

    expect(prog[prog.length - 1]).toEqual(expect.objectContaining({
      message: expect.stringContaining('no extractable text layer'),
    }));
    // Not auto-dismissed like a normal completion — the message stays.
    vi.advanceTimersByTime(10_000);
    expect(prog[prog.length - 1]).toEqual(expect.objectContaining({
      message: expect.stringContaining('no extractable text layer'),
    }));
    // ...but the user can still dismiss it.
    tc.bus.get('mark:progress-dismiss').next(undefined);
    expect(prog[prog.length - 1]).toBeNull();

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('a completion with a normal (non-declined) result still auto-dismisses', () => {
    vi.useFakeTimers();
    const progressSubject = new Subject();
    tc = withMark({ assist: vi.fn(() => progressSubject.asObservable()) });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const prog: unknown[] = [];
    stateUnit.progress$.subscribe(v => prog.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    progressSubject.next({ kind: 'progress', data: { stage: 'creating', percentage: 100, message: 'done' } });
    progressSubject.next({ kind: 'complete', data: { result: { highlightsFound: 3, highlightsCreated: 3 } } });
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

describe('MarkStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    assertStateUnitAxioms({
      setup: () => {
        const tc = withMark();
        return { unit: createMarkStateUnit(tc.client, RID), teardown: () => tc.bus.destroy() };
      },
      surfaces: (u) => [u.pendingAnnotation$, u.assistingMotivation$, u.progress$],
    });
  });

  // ── Multi-mounted units (MARK-REQUESTED-RESOURCE-SCOPE) ──────
  // N viewers on ONE session mount N units bound to N resources. The events
  // carry their source resource id and each unit handles only its own —
  // without this, one submit creates N annotations on N different resources.

  describe('multi-mounted units route by source resource', () => {
    let tc: TestClient;
    afterEach(() => { tc?.bus.destroy(); });

    it('mark:requested reaches only the unit bound to its source', () => {
      tc = withMark();
      const unitA = createMarkStateUnit(tc.client, makeResourceId('res-a'));
      const unitB = createMarkStateUnit(tc.client, makeResourceId('res-b'));
      const pendA: unknown[] = [];
      const pendB: unknown[] = [];
      unitA.pendingAnnotation$.subscribe(v => pendA.push(v));
      unitB.pendingAnnotation$.subscribe(v => pendB.push(v));

      tc.bus.get('mark:requested').next({
        source: 'res-a',
        selector: { type: 'TextQuoteSelector', exact: 'hello' },
        motivation: 'highlighting',
      } as any);

      expect(pendA[pendA.length - 1]).toEqual(expect.objectContaining({ motivation: 'highlighting' }));
      expect(pendB[pendB.length - 1]).toBeNull(); // B never fires
      unitA.dispose();
      unitB.dispose();
    });

    it('one mark:submit creates exactly ONE annotation, on the source resource', async () => {
      const annotationFn = vi.fn().mockResolvedValue({ annotationId: 'ann-1' });
      tc = withMark({ annotation: annotationFn });
      const unitA = createMarkStateUnit(tc.client, makeResourceId('res-a'));
      const unitB = createMarkStateUnit(tc.client, makeResourceId('res-b'));

      tc.bus.get('mark:submit').next({
        source: 'res-a',
        motivation: 'commenting',
        selector: { type: 'TextQuoteSelector', exact: 'x' },
        body: [{ type: 'TextualBody', value: 'hi' }],
      } as any);

      // Both handlers run in the same tick today (bus-wide subscribe): the
      // double-create is visible immediately; after the fix exactly one call.
      await vi.waitFor(() => expect(annotationFn).toHaveBeenCalled());
      expect(annotationFn).toHaveBeenCalledTimes(1);
      expect(annotationFn).toHaveBeenCalledWith(expect.objectContaining({
        target: expect.objectContaining({ source: makeResourceId('res-a') }),
      }));
      unitA.dispose();
      unitB.dispose();
    });
  });
});
