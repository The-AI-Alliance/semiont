import { describe, it, expect, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import type { GatheredContext } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { createGatherStateUnit } from '../gather-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';
import { resourceContextFor } from '../../../__tests__/fixtures/gathered-context';

const RID = makeResourceId('res-1');
const AID = makeAnnotationId('ann-1');
const AID2 = makeAnnotationId('ann-2');
const RESOURCE_CTX = resourceContextFor('res-1');

function withGather(gatherFn: ReturnType<typeof vi.fn>): TestClient {
  return makeTestClient({ gather: { annotation: gatherFn } });
}

function withBothGathers(
  annotationFn: ReturnType<typeof vi.fn>,
  resourceFn: ReturnType<typeof vi.fn>,
): TestClient {
  return makeTestClient({ gather: { annotation: annotationFn, resource: resourceFn } });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let a settled promise's `.then` chain inside the unit run. */
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

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

  it('sets context when the Observable emits a completion (response IS the GatheredContext)', () => {
    // P2b collapse: gather:complete carries a bare GatheredContext on `response`, not response.context.
    const mockContext = {
      focus: { kind: 'annotation', annotation: { id: 'ann-1' }, sourceResource: {} },
      graph: { nodes: [], edges: [] },
      metadata: {},
    };
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.next({ response: mockContext });
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

  it('leaves context null when the Observable emits a progress event (no response)', () => {
    const gatherFn = vi.fn(() => new Observable((sub) => {
      sub.next({ progress: 0.5 });
      sub.complete();
    }));
    tc = withGather(gatherFn);
    const stateUnit = createGatherStateUnit(tc.client, RID);

    const ctx: unknown[] = [];
    stateUnit.context$.subscribe(v => ctx.push(v));

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as any);
    // Initial null + the gather:requested clear-null; a progress event carries no `response`, so context is never set.
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

// ── Resource gather (FLOW-LIFECYCLE-CONVERGENCE P2, D2/D2a) ────────────────
// Separate slots: the two gathers can be live at once, and one BehaviorSubject
// cannot represent both — one fact per observable.

describe('GatherStateUnit — resource gather', () => {
  let tc: TestClient;

  afterEach(() => { tc?.bus.destroy(); });

  it('initializes the resource slots empty', () => {
    tc = withBothGathers(vi.fn(), vi.fn());
    const unit = createGatherStateUnit(tc.client, RID);

    const ctx: unknown[] = [];
    const loading: boolean[] = [];
    const err: unknown[] = [];
    unit.resourceContext$.subscribe(v => ctx.push(v));
    unit.resourceLoading$.subscribe(v => loading.push(v));
    unit.resourceError$.subscribe(v => err.push(v));

    expect(ctx).toEqual([null]);
    expect(loading).toEqual([false]);
    expect(err).toEqual([null]);
    unit.dispose();
  });

  it('gatherResource flips resourceLoading$ and lands the context', async () => {
    const d = deferred<GatheredContext>();
    const resourceFn = vi.fn(() => d.promise);
    tc = withBothGathers(vi.fn(), resourceFn);
    const unit = createGatherStateUnit(tc.client, RID);

    const loading: boolean[] = [];
    const ctx: unknown[] = [];
    unit.resourceLoading$.subscribe(v => loading.push(v));
    unit.resourceContext$.subscribe(v => ctx.push(v));

    unit.gatherResource(RID, { includeContent: true });
    expect(loading).toEqual([false, true]);
    expect(resourceFn).toHaveBeenCalledExactlyOnceWith(RID, { includeContent: true });

    d.resolve(RESOURCE_CTX);
    await flushMicrotasks();

    expect(ctx[ctx.length - 1]).toBe(RESOURCE_CTX);
    expect(loading[loading.length - 1]).toBe(false);
    unit.dispose();
  });

  it('resourceError$ carries the failure; the context slot stays empty', async () => {
    const d = deferred<GatheredContext>();
    tc = withBothGathers(vi.fn(), vi.fn(() => d.promise));
    const unit = createGatherStateUnit(tc.client, RID);

    const err: unknown[] = [];
    const ctx: unknown[] = [];
    const loading: boolean[] = [];
    unit.resourceError$.subscribe(v => err.push(v));
    unit.resourceContext$.subscribe(v => ctx.push(v));
    unit.resourceLoading$.subscribe(v => loading.push(v));

    unit.gatherResource(RID);
    d.reject(new Error('gather failed'));
    await flushMicrotasks();

    expect(err[err.length - 1]).toBeInstanceOf(Error);
    expect((err[err.length - 1] as Error).message).toBe('gather failed');
    expect(ctx[ctx.length - 1]).toBeNull();
    expect(loading[loading.length - 1]).toBe(false);
    unit.dispose();
  });

  it("concurrent annotation and resource gathers do not disturb each other's slots", async () => {
    // Annotation gather in-flight (subject never responds) while the resource
    // gather starts and finishes — the wizard-closed-mid-load / Generate-open
    // case D2a exists for.
    const annotationStream = new Subject();
    const d = deferred<GatheredContext>();
    tc = withBothGathers(vi.fn(() => annotationStream.asObservable()), vi.fn(() => d.promise));
    const unit = createGatherStateUnit(tc.client, RID);

    const annCtx: unknown[] = [];
    const annLoading: boolean[] = [];
    unit.context$.subscribe(v => annCtx.push(v));
    unit.loading$.subscribe(v => annLoading.push(v));

    tc.bus.get('gather:requested').next({ annotationId: AID as string } as never);
    unit.gatherResource(RID);
    d.resolve(RESOURCE_CTX);
    await flushMicrotasks();

    // The resource gather finished; the annotation slots are untouched:
    // still loading, still contextless.
    expect(annLoading[annLoading.length - 1]).toBe(true);
    expect(annCtx[annCtx.length - 1]).toBeNull();
    unit.dispose();
  });

  it('a resolution after dispose is inert', async () => {
    const d = deferred<GatheredContext>();
    tc = withBothGathers(vi.fn(), vi.fn(() => d.promise));
    const unit = createGatherStateUnit(tc.client, RID);

    const ctx: unknown[] = [];
    unit.resourceContext$.subscribe(v => ctx.push(v));

    unit.gatherResource(RID);
    const emissionsAtDispose = ctx.length; // initial null + the clearing null
    unit.dispose();
    d.resolve(RESOURCE_CTX);
    await flushMicrotasks();

    // Nothing landed after dispose: no new emissions, no context anywhere.
    expect(ctx.length).toBe(emissionsAtDispose);
    expect(ctx.every((v) => v === null)).toBe(true);
  });
});

describe('GatherStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    assertStateUnitAxioms({
      setup: () => {
        const tc = withBothGathers(vi.fn(), vi.fn());
        return { unit: createGatherStateUnit(tc.client, RID), teardown: () => tc.bus.destroy() };
      },
      surfaces: (u) => [
        u.context$, u.loading$, u.error$, u.annotationId$,
        u.resourceContext$, u.resourceLoading$, u.resourceError$,
      ],
    });
  });
});
