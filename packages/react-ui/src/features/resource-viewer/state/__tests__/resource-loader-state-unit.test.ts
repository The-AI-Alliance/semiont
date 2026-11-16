import { describe, it, expect, vi } from 'vitest';
import { asStates } from '../../../../__tests__/test-client';
import { sessionOf } from '../../../../__tests__/test-client';
import { BehaviorSubject, Subject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { resourceId as makeResourceId } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import { createResourceLoaderStateUnit } from '../resource-loader-state-unit';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';

const RID = makeResourceId('res-1');

function mockClient(resource$?: BehaviorSubject<unknown>): SemiontClient {
  const subject = resource$ ?? new BehaviorSubject<unknown>({ '@id': 'res-1', name: 'Test' });
  const invalidate = vi.fn();
  return {
    browse: {
      resource: () => asStates(subject.asObservable()),
      invalidateResourceDetail: invalidate,
    },
  } as unknown as SemiontClient;
}

/**
 * A client whose `browse.resource()` mirrors the cache's B15 contract: each
 * `observe()` call hands back a FRESH observable (the failure marker is
 * cleared and a new attempt chain starts), and a terminal failure arrives as
 * an RxJS error notification on that key.
 */
function failingClient() {
  const attempts: Array<Subject<unknown>> = [];
  const invalidate = vi.fn();
  const client = {
    browse: {
      resource: () => {
        const s = new Subject<unknown>();
        attempts.push(s);
        return s.asObservable();
      },
      invalidateResourceDetail: invalidate,
    },
  } as unknown as SemiontClient;
  return {
    client,
    invalidate,
    /** Fail the most recent attempt the way B15 does. */
    failLatest: (message: string) =>
      attempts[attempts.length - 1]!.next({ status: 'failed', error: new Error(message) }),
    /** Resolve the most recent attempt with a value. */
    resolveLatest: (value: unknown) =>
      attempts[attempts.length - 1]!.next({ status: 'ready', value }),
    attemptCount: () => attempts.length,
  };
}

describe('createResourceLoaderStateUnit', () => {
  it('exposes resource from browse namespace', async () => {
    const stateUnit = createResourceLoaderStateUnit(sessionOf(mockClient()), RID);
    const resource = await firstValueFrom(stateUnit.resource$.pipe(filter((r) => r !== undefined)));
    expect((resource as { name: string }).name).toBe('Test');
    stateUnit.dispose();
  });

  it('reports loading when resource is undefined', async () => {
    const subject = new BehaviorSubject<unknown>(undefined);
    const stateUnit = createResourceLoaderStateUnit(sessionOf(mockClient(subject)), RID);
    expect(await firstValueFrom(stateUnit.isLoading$)).toBe(true);

    subject.next({ '@id': 'res-1' });
    expect(await firstValueFrom(stateUnit.isLoading$.pipe(filter((l) => !l)))).toBe(false);
    stateUnit.dispose();
  });

  it('invalidate calls browse.invalidateResourceDetail', () => {
    const client = mockClient();
    const stateUnit = createResourceLoaderStateUnit(sessionOf(client), RID);
    stateUnit.invalidate();
    expect(client.browse.invalidateResourceDetail).toHaveBeenCalledWith(RID);
    stateUnit.dispose();
  });
});

describe('createResourceLoaderStateUnit — terminal failure (B15)', () => {
  // "Loading" cannot be defined as "no value yet": a key that fails with
  // nothing cached has no value EITHER, so a two-state model reports a dead
  // request as an eternal spinner and drops the reason on the floor. The
  // failure must be a state of its own.
  // See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md (D4)

  it('surfaces a terminal failure on error$ instead of leaving it undelivered', async () => {
    const h = failingClient();
    const stateUnit = createResourceLoaderStateUnit(sessionOf(h.client), RID);
    const seen: Array<Error | null> = [];
    stateUnit.error$.subscribe((e) => seen.push(e));

    expect(seen).toEqual([null]);
    h.failLatest('Resource not found');

    expect(seen.length).toBe(2);
    expect(seen[1]?.message).toBe('Resource not found');
    stateUnit.dispose();
  });

  it('stops reporting loading once the request has terminally failed', async () => {
    const h = failingClient();
    const stateUnit = createResourceLoaderStateUnit(sessionOf(h.client), RID);
    const loading: boolean[] = [];
    stateUnit.isLoading$.subscribe((l) => loading.push(l));

    expect(loading[loading.length - 1]).toBe(true);
    h.failLatest('Resource not found');

    // The defect: without a failure state this stays true forever, and the
    // page sits on "Loading resource..." with no way out.
    expect(loading[loading.length - 1]).toBe(false);
    stateUnit.dispose();
  });

  it('an error notification does not tear the unit down — invalidate starts a fresh attempt that can succeed', async () => {
    const h = failingClient();
    const stateUnit = createResourceLoaderStateUnit(sessionOf(h.client), RID);
    h.failLatest('Resource not found');
    expect(await firstValueFrom(stateUnit.error$)).not.toBeNull();

    stateUnit.invalidate();
    expect(h.invalidate).toHaveBeenCalledWith(RID);
    // B15: a fresh observe() clears the marker and restarts the chain, so the
    // unit must be listening to a NEW attempt, not the errored one.
    expect(h.attemptCount()).toBeGreaterThan(1);
    expect(await firstValueFrom(stateUnit.error$)).toBeNull();

    h.resolveLatest({ '@id': 'res-1', name: 'Recovered' });
    const resource = await firstValueFrom(stateUnit.resource$.pipe(filter((r) => r !== undefined)));
    expect((resource as { name: string }).name).toBe('Recovered');
    expect(await firstValueFrom(stateUnit.isLoading$)).toBe(false);
    stateUnit.dispose();
  });

  it('a value arriving after a failure clears the error', async () => {
    const h = failingClient();
    const stateUnit = createResourceLoaderStateUnit(sessionOf(h.client), RID);
    h.failLatest('transient');
    stateUnit.invalidate();
    h.resolveLatest({ '@id': 'res-1', name: 'Test' });

    expect(await firstValueFrom(stateUnit.error$)).toBeNull();
    stateUnit.dispose();
  });
});

describe('ResourceLoaderStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    // Owns resource$/error$ and a live subscription to client.browse, so
    // dispose completes them and detaches; invalidate is inert afterwards.
    assertStateUnitAxioms({
      setup: () => createResourceLoaderStateUnit(sessionOf(mockClient()), RID),
      invocations: (u) => [() => u.invalidate()],
    });
  });
});
