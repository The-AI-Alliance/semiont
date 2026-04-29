import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { createGatherStateUnit } from '../gather-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';

const RID = makeResourceId('res-1');
const AID = makeAnnotationId('ann-1');
const AID2 = makeAnnotationId('ann-2');

function withGather(gatherFn: ReturnType<typeof vi.fn>): TestClient {
  return makeTestClient({ gather: { annotation: gatherFn } });
}

describe('createGatherStateUnit', () => {
  let tc: TestClient;

  afterEach(() => { tc?.bus.destroy(); });

  it('initializes with null context, not loading, no error', () => {
    tc = withGather(vi.fn());
    const stateUnit = createGatherStateUnit(tc.client, RID);

    const ctx: unknown[] = [];
    const loading: boolean[] = [];
    const err: unknown[] = [];
    stateUnit.context$.subscribe(v => ctx.push(v));
    stateUnit.loading$.subscribe(v => loading.push(v));
    stateUnit.error$.subscribe(v => err.push(v));

    expect(ctx).toEqual([null]);
    expect(loading).toEqual([false]);
    expect(err).toEqual([null]);
    stateUnit.dispose();
  });

  it('does not call gather.annotation on creation', () => {
    const gatherFn = vi.fn();
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);
    expect(gatherFn).not.toHaveBeenCalled();
    stateUnit.dispose();
  });

  it('sets loading on gather:requested', () => {
    const subject = new Subject();
    const gatherFn = vi.fn(() => subject.asObservable());
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);

    const loading: boolean[] = [];
    stateUnit.loading$.subscribe(v => loading.push(v));

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(loading).toEqual([false, true]);
    expect(gatherFn).toHaveBeenCalledOnce();
    stateUnit.dispose();
  });

  it('sets annotationId on gather:requested', () => {
    const gatherFn = vi.fn(() => new Observable(() => {}));
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);

    const ids: unknown[] = [];
    stateUnit.annotationId$.subscribe(v => ids.push(v));

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(ids).toEqual([null, AID]);
    stateUnit.dispose();
  });

  it('sets context when Observable emits completion with response.context', () => {
    const mockContext = { annotation: { id: 'ann-1' }, sourceResource: {}, sourceContext: 'text' };
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.next({ response: { context: mockContext } });
      sub.complete();
    }));
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);

    const ctx: unknown[] = [];
    const loading: boolean[] = [];
    stateUnit.context$.subscribe(v => ctx.push(v));
    stateUnit.loading$.subscribe(v => loading.push(v));

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(ctx).toEqual([null, null, mockContext]);
    expect(loading[loading.length - 1]).toBe(false);
    stateUnit.dispose();
  });

  it('sets null context when Observable emits progress without context', () => {
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.next({ response: {} });
      sub.complete();
    }));
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);

    const ctx: unknown[] = [];
    stateUnit.context$.subscribe(v => ctx.push(v));

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    // Initial null, cleared null from gather:requested, no context set (response has no context)
    expect(ctx.every(v => v === null)).toBe(true);
    stateUnit.dispose();
  });

  it('sets error when Observable errors', () => {
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.error(new Error('gather failed'));
    }));
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);

    const errors: unknown[] = [];
    const loading: boolean[] = [];
    stateUnit.error$.subscribe(v => errors.push(v));
    stateUnit.loading$.subscribe(v => loading.push(v));

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(errors[errors.length - 1]).toEqual(new Error('gather failed'));
    expect(loading[loading.length - 1]).toBe(false);
    stateUnit.dispose();
  });

  it('clears previous error and context on new gather:requested', () => {
    // First request errors
    const gatherFn = vi.fn()
      .mockReturnValueOnce(new Observable((sub) => { sub.error(new Error('fail')); }))
      .mockReturnValueOnce(new Observable(() => {}));
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);

    const errors: unknown[] = [];
    stateUnit.error$.subscribe(v => errors.push(v));

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(errors[errors.length - 1]).toEqual(new Error('fail'));

    // Second request clears error
    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(errors[errors.length - 1]).toBeNull();
    stateUnit.dispose();
  });

  it('updates annotationId on each gather:requested', () => {
    const gatherFn = vi.fn(() => new Observable(() => {}));
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);

    const ids: unknown[] = [];
    stateUnit.annotationId$.subscribe(v => ids.push(v));

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    tc.bus.get('gather:requested').next({ annotationId: AID2 as string } as any);
    expect(ids).toEqual([null, AID, AID2]);
    stateUnit.dispose();
  });

  it('errors with timeout when Observable does not complete within 60s', () => {
    vi.useFakeTimers();
    const gatherFn = vi.fn(() => new Observable(() => {}));
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);

    const errors: unknown[] = [];
    const loading: boolean[] = [];
    stateUnit.error$.subscribe(v => errors.push(v));
    stateUnit.loading$.subscribe(v => loading.push(v));

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(loading[loading.length - 1]).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(errors[errors.length - 1]).toBeInstanceOf(Error);
    expect(loading[loading.length - 1]).toBe(false);

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('stops responding after dispose', () => {
    const gatherFn = vi.fn();
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);
    stateUnit.dispose();

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(gatherFn).not.toHaveBeenCalled();
  });
});
