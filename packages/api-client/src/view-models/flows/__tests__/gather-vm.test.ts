import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { createGatherVM } from '../gather-vm';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';

const RID = makeResourceId('res-1');
const AID = makeAnnotationId('ann-1');
const AID2 = makeAnnotationId('ann-2');

function withGather(gatherFn: ReturnType<typeof vi.fn>): TestClient {
  return makeTestClient({ gather: { annotation: gatherFn } });
}

describe('createGatherVM', () => {
  let tc: TestClient;

  afterEach(() => { tc?.bus.destroy(); });

  it('initializes with null context, not loading, no error', () => {
    tc = withGather(vi.fn());
    const vm = createGatherVM(tc.client, RID);

    const ctx: unknown[] = [];
    const loading: boolean[] = [];
    const err: unknown[] = [];
    vm.context$.subscribe(v => ctx.push(v));
    vm.loading$.subscribe(v => loading.push(v));
    vm.error$.subscribe(v => err.push(v));

    expect(ctx).toEqual([null]);
    expect(loading).toEqual([false]);
    expect(err).toEqual([null]);
    vm.dispose();
  });

  it('does not call gather.annotation on creation', () => {
    const gatherFn = vi.fn();
    tc = withGather(gatherFn);
    const vm = createGatherVM(tc.client, RID);
    expect(gatherFn).not.toHaveBeenCalled();
    vm.dispose();
  });

  it('sets loading on gather:requested', () => {
    const subject = new Subject();
    const gatherFn = vi.fn(() => subject.asObservable());
    tc = withGather(gatherFn);
    const vm = createGatherVM(tc.client, RID);

    const loading: boolean[] = [];
    vm.loading$.subscribe(v => loading.push(v));

    tc.client.emit('gather:requested', { annotationId: AID as string } as any);
    expect(loading).toEqual([false, true]);
    expect(gatherFn).toHaveBeenCalledOnce();
    vm.dispose();
  });

  it('sets annotationId on gather:requested', () => {
    const gatherFn = vi.fn(() => new Observable(() => {}));
    tc = withGather(gatherFn);
    const vm = createGatherVM(tc.client, RID);

    const ids: unknown[] = [];
    vm.annotationId$.subscribe(v => ids.push(v));

    tc.client.emit('gather:requested', { annotationId: AID as string } as any);
    expect(ids).toEqual([null, AID]);
    vm.dispose();
  });

  it('sets context when Observable emits completion with response.context', () => {
    const mockContext = { annotation: { id: 'ann-1' }, sourceResource: {}, sourceContext: 'text' };
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.next({ response: { context: mockContext } });
      sub.complete();
    }));
    tc = withGather(gatherFn);
    const vm = createGatherVM(tc.client, RID);

    const ctx: unknown[] = [];
    const loading: boolean[] = [];
    vm.context$.subscribe(v => ctx.push(v));
    vm.loading$.subscribe(v => loading.push(v));

    tc.client.emit('gather:requested', { annotationId: AID as string } as any);
    expect(ctx).toEqual([null, null, mockContext]);
    expect(loading[loading.length - 1]).toBe(false);
    vm.dispose();
  });

  it('sets null context when Observable emits progress without context', () => {
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.next({ response: {} });
      sub.complete();
    }));
    tc = withGather(gatherFn);
    const vm = createGatherVM(tc.client, RID);

    const ctx: unknown[] = [];
    vm.context$.subscribe(v => ctx.push(v));

    tc.client.emit('gather:requested', { annotationId: AID as string } as any);
    // Initial null, cleared null from gather:requested, no context set (response has no context)
    expect(ctx.every(v => v === null)).toBe(true);
    vm.dispose();
  });

  it('sets error when Observable errors', () => {
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.error(new Error('gather failed'));
    }));
    tc = withGather(gatherFn);
    const vm = createGatherVM(tc.client, RID);

    const errors: unknown[] = [];
    const loading: boolean[] = [];
    vm.error$.subscribe(v => errors.push(v));
    vm.loading$.subscribe(v => loading.push(v));

    tc.client.emit('gather:requested', { annotationId: AID as string } as any);
    expect(errors[errors.length - 1]).toEqual(new Error('gather failed'));
    expect(loading[loading.length - 1]).toBe(false);
    vm.dispose();
  });

  it('clears previous error and context on new gather:requested', () => {
    // First request errors
    const gatherFn = vi.fn()
      .mockReturnValueOnce(new Observable((sub) => { sub.error(new Error('fail')); }))
      .mockReturnValueOnce(new Observable(() => {}));
    tc = withGather(gatherFn);
    const vm = createGatherVM(tc.client, RID);

    const errors: unknown[] = [];
    vm.error$.subscribe(v => errors.push(v));

    tc.client.emit('gather:requested', { annotationId: AID as string } as any);
    expect(errors[errors.length - 1]).toEqual(new Error('fail'));

    // Second request clears error
    tc.client.emit('gather:requested', { annotationId: AID as string } as any);
    expect(errors[errors.length - 1]).toBeNull();
    vm.dispose();
  });

  it('updates annotationId on each gather:requested', () => {
    const gatherFn = vi.fn(() => new Observable(() => {}));
    tc = withGather(gatherFn);
    const vm = createGatherVM(tc.client, RID);

    const ids: unknown[] = [];
    vm.annotationId$.subscribe(v => ids.push(v));

    tc.client.emit('gather:requested', { annotationId: AID as string } as any);
    tc.client.emit('gather:requested', { annotationId: AID2 as string } as any);
    expect(ids).toEqual([null, AID, AID2]);
    vm.dispose();
  });

  it('errors with timeout when Observable does not complete within 60s', () => {
    vi.useFakeTimers();
    const gatherFn = vi.fn(() => new Observable(() => {}));
    tc = withGather(gatherFn);
    const vm = createGatherVM(tc.client, RID);

    const errors: unknown[] = [];
    const loading: boolean[] = [];
    vm.error$.subscribe(v => errors.push(v));
    vm.loading$.subscribe(v => loading.push(v));

    tc.client.emit('gather:requested', { annotationId: AID as string } as any);
    expect(loading[loading.length - 1]).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(errors[errors.length - 1]).toBeInstanceOf(Error);
    expect(loading[loading.length - 1]).toBe(false);

    vm.dispose();
    vi.useRealTimers();
  });

  it('stops responding after dispose', () => {
    const gatherFn = vi.fn();
    tc = withGather(gatherFn);
    const vm = createGatherVM(tc.client, RID);
    vm.dispose();

    tc.client.emit('gather:requested', { annotationId: AID as string } as any);
    expect(gatherFn).not.toHaveBeenCalled();
  });
});
