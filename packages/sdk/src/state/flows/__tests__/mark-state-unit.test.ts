import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { resourceId as makeResourceId } from '@semiont/core';
import { createMarkStateUnit, ASSIST_SILENCE_MS } from '../mark-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';

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

  it('emits mark:create-error (resource-stamped, client-local) when submit errors', async () => {
    // The awaiting catch is the one place that knows whose command failed on
    // which resource — it emits the UI notification. The wire reply channel
    // (mark:create-failed, CommandError) stays busRequest plumbing.
    const annotationFn = vi.fn().mockRejectedValue(new Error('Network error'));
    tc = withMark({ annotation: annotationFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const failures: unknown[] = [];
    tc.bus.get('mark:create-error').subscribe(e => failures.push(e));

    tc.bus.get('mark:submit').next({
      source: 'res-1',
      motivation: 'highlighting',
      selector: { type: 'TextQuoteSelector', exact: 'x' },
    } as any);

    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toEqual({ resourceId: 'res-1', message: 'Network error' });
    stateUnit.dispose();
  });

  it('emits mark:delete-error (resource-stamped, client-local) when delete errors', async () => {
    const deleteFn = vi.fn().mockRejectedValue(new Error('gone wrong'));
    tc = withMark({ delete: deleteFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const failures: unknown[] = [];
    tc.bus.get('mark:delete-error').subscribe(e => failures.push(e));

    tc.bus.get('mark:delete').next({ annotationId: 'ann-del' } as any);

    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toEqual({ resourceId: 'res-1', message: 'gone wrong' });
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

  it('HOLDS a silent assist after 180s — the job is still running, so the client must not forget it', () => {
    // DETECTION-HEARTBEAT Phase B. Silence is not failure: the worker keeps
    // processing after the client stops hearing (proven live 2026-08-07 — a
    // job that "timed out" in the UI persisted 221 annotations). Dropping
    // assistingMotivation$ told the user the assist was over while it was
    // still running, and left nothing to resolve when it finished.
    vi.useFakeTimers();
    const assistFn = vi.fn(() => new Observable(() => {}));
    tc = withMark({ assist: assistFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const motiv: unknown[] = [];
    const prog: unknown[] = [];
    stateUnit.assistingMotivation$.subscribe(v => motiv.push(v));
    stateUnit.progress$.subscribe(v => prog.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    expect(motiv[motiv.length - 1]).toBe('highlighting');

    vi.advanceTimersByTime(ASSIST_SILENCE_MS);

    // Still assisting — the silence tick refreshes progress$ (no prose: the
    // SDK emits codes or nothing; the stale-notice copy is the UI's, driven
    // by the mark:assist-timeout event asserted elsewhere in this file).
    expect(motiv[motiv.length - 1]).toBe('highlighting');
    const last = prog[prog.length - 1] as { stage?: string; message?: unknown } | null;
    expect(last).not.toBeNull();
    expect(last?.stage).toBe('analyzing');
    expect(last?.message).toBeUndefined();

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('a completion arriving AFTER the silence window still resolves the UI', () => {
    // The stream must survive the silence marker: if the subscription is torn
    // down at 180 s, the job's real completion has nothing left to resolve
    // and the spinner is stuck forever.
    vi.useFakeTimers();
    let emit!: { complete: () => void };
    tc = withMark({ assist: vi.fn(() => new Observable((sub) => { emit = sub; })) });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const motiv: unknown[] = [];
    stateUnit.assistingMotivation$.subscribe(v => motiv.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    vi.advanceTimersByTime(ASSIST_SILENCE_MS);
    expect(motiv[motiv.length - 1]).toBe('highlighting'); // held

    // The worker finishes six minutes in, as it does on a real large document.
    vi.advanceTimersByTime(ASSIST_SILENCE_MS + 20_000);
    emit.complete();

    expect(motiv[motiv.length - 1]).toBeNull();

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('emits mark:assist-timeout when a silent assist times out (nothing else will tell the user)', () => {
    // A client-side timeout means no job:fail ever fired — without this
    // emission the spinner just vanishes and the stall is invisible.
    vi.useFakeTimers();
    tc = withMark({ assist: vi.fn(() => new Observable(() => {})) });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const timeouts: unknown[] = [];
    tc.bus.get('mark:assist-timeout').subscribe(e => timeouts.push(e));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    vi.advanceTimersByTime(ASSIST_SILENCE_MS);

    expect(timeouts).toEqual([{ resourceId: 'res-1', motivation: 'highlighting' }]);

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('does not emit mark:assist-timeout for a real assist error (the job:fail path owns those)', () => {
    // mark.assist errors its Observable when job:fail arrives; that failure
    // already toasts via the job:fail outcome channel — a timeout emission
    // here would double-notify.
    tc = withMark({ assist: vi.fn(() => new Observable((sub) => { sub.error(new Error('LLM down')); })) });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const timeouts: unknown[] = [];
    tc.bus.get('mark:assist-timeout').subscribe(e => timeouts.push(e));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);

    expect(timeouts).toEqual([]);
    stateUnit.dispose();
  });

  it('resets the silence window on each progress emission (does not fire prematurely)', () => {
    // This is what the worker heartbeat feeds: a beat every ~15 s keeps the
    // window from ever being reached on a healthy long-running job.
    vi.useFakeTimers();
    const progressSubject = new Subject();
    const assistFn = vi.fn(() => progressSubject.asObservable());
    tc = withMark({ assist: assistFn });
    const stateUnit = createMarkStateUnit(tc.client, RID);
    const timeouts: unknown[] = [];
    tc.bus.get('mark:assist-timeout').subscribe(e => timeouts.push(e));
    const motiv: unknown[] = [];
    stateUnit.assistingMotivation$.subscribe(v => motiv.push(v));

    tc.bus.get('mark:assist-request').next({ motivation: 'highlighting', options: {} } as any);
    expect(motiv[motiv.length - 1]).toBe('highlighting');

    vi.advanceTimersByTime(ASSIST_SILENCE_MS - 10_000);
    progressSubject.next({ kind: 'progress', data: { stage: 'analyzing', percentage: 50, message: 'm' } });

    // The emission reset the window — nothing has gone quiet.
    vi.advanceTimersByTime(ASSIST_SILENCE_MS - 10_000);
    expect(timeouts).toEqual([]);

    // Past the window with no further emissions: the user is told it went
    // quiet, but the assist is still held (the job is still running).
    vi.advanceTimersByTime(10_000);
    expect(timeouts).toHaveLength(1);
    expect(motiv[motiv.length - 1]).toBe('highlighting');

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
