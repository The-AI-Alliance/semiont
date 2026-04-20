import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { resourceId as makeResourceId } from '@semiont/core';
import { createMarkVM } from '../mark-vm';
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

describe('createMarkVM', () => {
  let tc: TestClient;

  afterEach(() => { tc?.bus.destroy(); });

  it('initializes with null pending, null motivation, null progress', () => {
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
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
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const pend: unknown[] = [];
    vm.pendingAnnotation$.subscribe(v => pend.push(v));

    tc.client.emit('mark:requested', {
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
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const pend: unknown[] = [];
    vm.pendingAnnotation$.subscribe(v => pend.push(v));

    tc.client.emit('mark:select-comment', { exact: 'text', prefix: 'pre', suffix: 'suf' } as any);
    const last = pend[pend.length - 1] as any;
    expect(last.motivation).toBe('commenting');
    expect(last.selector).toEqual({ type: 'TextQuoteSelector', exact: 'text', prefix: 'pre', suffix: 'suf' });
    vm.dispose();
  });

  it('opens annotations panel on mark:requested', () => {
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const panels: string[] = [];
    tc.client.on('browse:panel-open', e => panels.push(e.panel));

    tc.client.emit('mark:requested', { selector: {}, motivation: 'highlighting' } as any);
    expect(panels).toEqual(['annotations']);
    vm.dispose();
  });

  it('clears pendingAnnotation on mark:cancel-pending', () => {
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const pend: unknown[] = [];
    vm.pendingAnnotation$.subscribe(v => pend.push(v));

    tc.client.emit('mark:requested', { selector: {}, motivation: 'highlighting' } as any);
    tc.client.emit('mark:cancel-pending', undefined);
    expect(pend[pend.length - 1]).toBeNull();
    vm.dispose();
  });

  it('clears pendingAnnotation on mark:create-ok', () => {
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const pend: unknown[] = [];
    vm.pendingAnnotation$.subscribe(v => pend.push(v));

    tc.client.emit('mark:requested', { selector: {}, motivation: 'highlighting' } as any);
    tc.client.emit('mark:create-ok', { annotationId: 'ann-1' });
    expect(pend[pend.length - 1]).toBeNull();
    vm.dispose();
  });

  // ── CRUD bridging ──────────────────────────────────────────

  it('bridges mark:submit to client.mark.annotation', async () => {
    const annotationFn = vi.fn().mockResolvedValue({ annotationId: 'ann-new' });
    tc = withMark({ annotation: annotationFn });
    const vm = createMarkVM(tc.client, RID);
    const okEvents: unknown[] = [];
    tc.client.on('mark:create-ok', e => okEvents.push(e));

    tc.client.emit('mark:submit', {
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
    tc = withMark({ annotation: annotationFn });
    const vm = createMarkVM(tc.client, RID);
    const failures: unknown[] = [];
    tc.client.on('mark:create-failed', e => failures.push(e));

    tc.client.emit('mark:submit', {
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
    tc = withMark({ delete: deleteFn });
    const vm = createMarkVM(tc.client, RID);
    const okEvents: unknown[] = [];
    tc.client.on('mark:delete-ok', e => okEvents.push(e));

    tc.client.emit('mark:delete', { annotationId: 'ann-del' } as any);

    await vi.waitFor(() => expect(deleteFn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(okEvents).toHaveLength(1));
    vm.dispose();
  });

  // ── AI assist ──────────────────────────────────────────────

  it('sets assistingMotivation on mark:assist-request', () => {
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const motiv: unknown[] = [];
    vm.assistingMotivation$.subscribe(v => motiv.push(v));

    tc.client.emit('mark:assist-request', { motivation: 'highlighting', options: {} } as any);
    expect(motiv[motiv.length - 1]).toBe('highlighting');
    vm.dispose();
  });

  it('updates progress on mark:progress', () => {
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const prog: unknown[] = [];
    vm.progress$.subscribe(v => prog.push(v));

    tc.client.emit('mark:progress', { status: 'in-progress', percentage: 42 } as any);
    expect(prog[prog.length - 1]).toEqual({ status: 'in-progress', percentage: 42 });
    vm.dispose();
  });

  it('clears assistingMotivation on mark:assist-finished when motivation matches', () => {
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const motiv: unknown[] = [];
    vm.assistingMotivation$.subscribe(v => motiv.push(v));

    tc.client.emit('mark:assist-request', { motivation: 'highlighting', options: {} } as any);
    tc.client.emit('mark:assist-finished', { motivation: 'highlighting' } as any);
    expect(motiv[motiv.length - 1]).toBeNull();
    vm.dispose();
  });

  it('keeps assistingMotivation on mark:assist-finished when motivation differs', () => {
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const motiv: unknown[] = [];
    vm.assistingMotivation$.subscribe(v => motiv.push(v));

    tc.client.emit('mark:assist-request', { motivation: 'highlighting', options: {} } as any);
    tc.client.emit('mark:assist-finished', { motivation: 'commenting' } as any);
    expect(motiv[motiv.length - 1]).toBe('highlighting');
    vm.dispose();
  });

  it('clears all assist state on mark:assist-failed', () => {
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const motiv: unknown[] = [];
    const prog: unknown[] = [];
    vm.assistingMotivation$.subscribe(v => motiv.push(v));
    vm.progress$.subscribe(v => prog.push(v));

    tc.client.emit('mark:assist-request', { motivation: 'highlighting', options: {} } as any);
    tc.client.emit('mark:progress', { status: 'x', percentage: 50 } as any);
    tc.client.emit('mark:assist-failed', { message: 'LLM error' } as any);

    expect(motiv[motiv.length - 1]).toBeNull();
    expect(prog[prog.length - 1]).toBeNull();
    vm.dispose();
  });

  it('clears progress on mark:progress-dismiss', () => {
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const prog: unknown[] = [];
    vm.progress$.subscribe(v => prog.push(v));

    tc.client.emit('mark:progress', { status: 'x', percentage: 50 } as any);
    tc.client.emit('mark:progress-dismiss', undefined);
    expect(prog[prog.length - 1]).toBeNull();
    vm.dispose();
  });

  it('dismisses progress after 5s on mark:assist-finished', () => {
    vi.useFakeTimers();
    tc = withMark();
    const vm = createMarkVM(tc.client, RID);
    const prog: unknown[] = [];
    vm.progress$.subscribe(v => prog.push(v));

    tc.client.emit('mark:progress', { status: 'x', percentage: 50 } as any);
    tc.client.emit('mark:assist-finished', { motivation: 'highlighting' } as any);

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
    tc = withMark({ assist: assistFn });
    const vm = createMarkVM(tc.client, RID);
    const failures: unknown[] = [];
    tc.client.on('mark:assist-failed', e => failures.push(e));

    tc.client.emit('mark:assist-request', { motivation: 'highlighting', options: {} } as any);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual(expect.objectContaining({ message: 'LLM down' }));
    vm.dispose();
  });

  it('emits mark:assist-failed on timeout when no progress within 180s', () => {
    vi.useFakeTimers();
    const assistFn = vi.fn(() => new Observable(() => {}));
    tc = withMark({ assist: assistFn });
    const vm = createMarkVM(tc.client, RID);
    const failures: unknown[] = [];
    tc.client.on('mark:assist-failed', e => failures.push(e));

    tc.client.emit('mark:assist-request', { motivation: 'highlighting', options: {} } as any);
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
    tc = withMark({ assist: assistFn });
    const vm = createMarkVM(tc.client, RID);
    const failures: unknown[] = [];
    tc.client.on('mark:assist-failed', e => failures.push(e));

    tc.client.emit('mark:assist-request', { motivation: 'highlighting', options: {} } as any);

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
    tc = withMark({ annotation: annotationFn });
    const vm = createMarkVM(tc.client, RID);
    vm.dispose();

    tc.client.emit('mark:submit', { motivation: 'highlighting', selector: {}, body: [] } as any);
    expect(annotationFn).not.toHaveBeenCalled();
  });
});
