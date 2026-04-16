import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import type { SemiontApiClient } from '../../../client';
import { createGatherVM } from '../gather-vm';

const RID = makeResourceId('res-1');
const AID = makeAnnotationId('ann-1');
const AID2 = makeAnnotationId('ann-2');

function mockClient(gatherFn: ReturnType<typeof vi.fn>): SemiontApiClient {
  return { gather: { annotation: gatherFn } } as unknown as SemiontApiClient;
}

describe('createGatherVM', () => {
  let eventBus: EventBus;

  beforeEach(() => { eventBus = new EventBus(); });
  afterEach(() => { eventBus.destroy(); });

  it('initializes with null context, not loading, no error', () => {
    const client = mockClient(vi.fn());
    const vm = createGatherVM(client, eventBus, RID);

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
    const client = mockClient(gatherFn);
    const vm = createGatherVM(client, eventBus, RID);
    expect(gatherFn).not.toHaveBeenCalled();
    vm.dispose();
  });

  it('sets loading on gather:requested', () => {
    const subject = new Subject();
    const gatherFn = vi.fn(() => subject.asObservable());
    const client = mockClient(gatherFn);
    const vm = createGatherVM(client, eventBus, RID);

    const loading: boolean[] = [];
    vm.loading$.subscribe(v => loading.push(v));

    eventBus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(loading).toEqual([false, true]);
    expect(gatherFn).toHaveBeenCalledOnce();
    vm.dispose();
  });

  it('sets annotationId on gather:requested', () => {
    const gatherFn = vi.fn(() => new Observable(() => {}));
    const client = mockClient(gatherFn);
    const vm = createGatherVM(client, eventBus, RID);

    const ids: unknown[] = [];
    vm.annotationId$.subscribe(v => ids.push(v));

    eventBus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(ids).toEqual([null, AID]);
    vm.dispose();
  });

  it('sets context when Observable emits completion with response.context', () => {
    const mockContext = { annotation: { id: 'ann-1' }, sourceResource: {}, sourceContext: 'text' };
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.next({ response: { context: mockContext } });
      sub.complete();
    }));
    const client = mockClient(gatherFn);
    const vm = createGatherVM(client, eventBus, RID);

    const ctx: unknown[] = [];
    const loading: boolean[] = [];
    vm.context$.subscribe(v => ctx.push(v));
    vm.loading$.subscribe(v => loading.push(v));

    eventBus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(ctx).toEqual([null, null, mockContext]);
    expect(loading[loading.length - 1]).toBe(false);
    vm.dispose();
  });

  it('sets null context when Observable emits progress without context', () => {
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.next({ response: {} });
      sub.complete();
    }));
    const client = mockClient(gatherFn);
    const vm = createGatherVM(client, eventBus, RID);

    const ctx: unknown[] = [];
    vm.context$.subscribe(v => ctx.push(v));

    eventBus.get('gather:requested').next({ annotationId: AID as string } as any);
    // Initial null, cleared null from gather:requested, no context set (response has no context)
    expect(ctx.every(v => v === null)).toBe(true);
    vm.dispose();
  });

  it('sets error when Observable errors', () => {
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.error(new Error('gather failed'));
    }));
    const client = mockClient(gatherFn);
    const vm = createGatherVM(client, eventBus, RID);

    const errors: unknown[] = [];
    const loading: boolean[] = [];
    vm.error$.subscribe(v => errors.push(v));
    vm.loading$.subscribe(v => loading.push(v));

    eventBus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(errors[errors.length - 1]).toEqual(new Error('gather failed'));
    expect(loading[loading.length - 1]).toBe(false);
    vm.dispose();
  });

  it('clears previous error and context on new gather:requested', () => {
    // First request errors
    const gatherFn = vi.fn()
      .mockReturnValueOnce(new Observable((sub) => { sub.error(new Error('fail')); }))
      .mockReturnValueOnce(new Observable(() => {}));
    const client = mockClient(gatherFn);
    const vm = createGatherVM(client, eventBus, RID);

    const errors: unknown[] = [];
    vm.error$.subscribe(v => errors.push(v));

    eventBus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(errors[errors.length - 1]).toEqual(new Error('fail'));

    // Second request clears error
    eventBus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(errors[errors.length - 1]).toBeNull();
    vm.dispose();
  });

  it('updates annotationId on each gather:requested', () => {
    const gatherFn = vi.fn(() => new Observable(() => {}));
    const client = mockClient(gatherFn);
    const vm = createGatherVM(client, eventBus, RID);

    const ids: unknown[] = [];
    vm.annotationId$.subscribe(v => ids.push(v));

    eventBus.get('gather:requested').next({ annotationId: AID as string } as any);
    eventBus.get('gather:requested').next({ annotationId: AID2 as string } as any);
    expect(ids).toEqual([null, AID, AID2]);
    vm.dispose();
  });

  it('errors with timeout when Observable does not complete within 60s', () => {
    vi.useFakeTimers();
    const gatherFn = vi.fn(() => new Observable(() => {}));
    const client = mockClient(gatherFn);
    const vm = createGatherVM(client, eventBus, RID);

    const errors: unknown[] = [];
    const loading: boolean[] = [];
    vm.error$.subscribe(v => errors.push(v));
    vm.loading$.subscribe(v => loading.push(v));

    eventBus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(loading[loading.length - 1]).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(errors[errors.length - 1]).toBeInstanceOf(Error);
    expect(loading[loading.length - 1]).toBe(false);

    vm.dispose();
    vi.useRealTimers();
  });

  it('stops responding after dispose', () => {
    const gatherFn = vi.fn();
    const client = mockClient(gatherFn);
    const vm = createGatherVM(client, eventBus, RID);
    vm.dispose();

    eventBus.get('gather:requested').next({ annotationId: AID as string } as any);
    expect(gatherFn).not.toHaveBeenCalled();
  });
});
