/**
 * Identity / re-creation seam tests for useViewModel.
 *
 * These tests probe the "what if the client/cache reference changes after
 * the VM has been constructed" seam — the strongest remaining candidate
 * for the test 05 entity-types failure after Layer 2/3/5-6 unit tests
 * all came back green.
 *
 * Three scenarios modeled:
 *  1. useViewModel's factory is called once and captures the initial
 *     closure — subsequent prop/context changes do NOT re-run the factory.
 *     A VM that captured `clientA.browse` keeps pointing at it forever.
 *  2. If `clientA` is replaced by `clientB` in context, and `clientB.browse`
 *     is the one actually receiving bus events, the VM (still on `clientA`)
 *     sees nothing.
 *  3. Even if we re-run the factory, an in-flight fetch on `clientA` may
 *     resolve AFTER `clientB` is live — writing the response into a dead
 *     cache that nobody observes.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BehaviorSubject, Subject, filter, map } from 'rxjs';
import { EventBus } from '@semiont/core';
import {
  BrowseNamespace,
  type SemiontApiClient,
  type ActorVM,
  type BusEvent,
  type ConnectionState,
} from '@semiont/api-client';
import { useViewModel } from '../useViewModel';
import { useObservable } from '../useObservable';

const NINE_TYPES = [
  'Author', 'Concept', 'Date', 'Event', 'Location',
  'Organization', 'Person', 'Product', 'Technology',
];

/**
 * Build a minimal BrowseNamespace with a controllable mock actor. The
 * returned `answer` function lets the test decide when/what the actor
 * emits in response to the next entity-types request.
 */
function makeBrowse(answerEntityTypes: string[]) {
  const events$ = new Subject<BusEvent>();
  const emit = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    if (channel === 'browse:entity-types-requested') {
      const correlationId = payload.correlationId as string;
      queueMicrotask(() => {
        events$.next({
          channel: 'browse:entity-types-result',
          payload: { correlationId, response: { entityTypes: answerEntityTypes } },
        });
      });
    }
  });
  const actor = {
    on$<T>(channel: string) {
      return events$.pipe(filter((e) => e.channel === channel), map((e) => e.payload as T));
    },
    emit,
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
    addChannels: vi.fn(),
    removeChannels: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  } as ActorVM;
  const http = {} as unknown as SemiontApiClient;
  const eventBus = new EventBus();
  return new BrowseNamespace(http, eventBus, () => undefined, actor);
}

/**
 * A VM factory mirroring what ResourceViewerPage does: captures `browse`
 * at factory-invocation time and pipes `.entityTypes()` into `$`.
 */
function createToyVM(browse: BrowseNamespace) {
  const entityTypes$ = browse.entityTypes().pipe(map((e) => e ?? []));
  return {
    entityTypes$,
    dispose: () => { /* noop */ },
  };
}

describe('useViewModel identity seam — stale client references', () => {
  it(
    'FACTORY RUNS ONCE: changing the browse prop does NOT re-create the VM',
    async () => {
      const browseA = makeBrowse(NINE_TYPES);
      const browseB = makeBrowse(['FromBrowseB']);

      let observedTypes: string[] = [];

      function Harness({ browse }: { browse: BrowseNamespace }) {
        const vm = useViewModel(() => createToyVM(browse));
        const types = useObservable(vm.entityTypes$) ?? [];
        observedTypes = types;
        return <div data-testid="types">{types.join(',')}</div>;
      }

      const { rerender } = render(<Harness browse={browseA} />);

      // Let browseA's fetch complete.
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(observedTypes).toEqual(NINE_TYPES);

      // Now swap to browseB. VM factory is NOT re-run — VM still points
      // to browseA, so the observed value stays at NINE_TYPES (not
      // ['FromBrowseB']).
      rerender(<Harness browse={browseB} />);
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

      // The point: observedTypes reflects browseA's data, not browseB's.
      // This is how a stale-client-ref bug manifests.
      expect(observedTypes).toEqual(NINE_TYPES);
    },
  );

  it(
    'STALE-FETCH DANGER: if client swap happens BEFORE first fetch resolves, the live client never gets queried',
    async () => {
      // Defer browseA's response so the client swap wins the race.
      const deferredEvents$ = new Subject<BusEvent>();
      const deferredEmit = vi.fn().mockImplementation(async () => { /* never answers */ });
      const browseA = new BrowseNamespace(
        {} as unknown as SemiontApiClient,
        new EventBus(),
        () => undefined,
        {
          on$<T>(channel: string) {
            return deferredEvents$.pipe(filter((e) => e.channel === channel), map((e) => e.payload as T));
          },
          emit: deferredEmit,
          state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
          addChannels: vi.fn(),
          removeChannels: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          dispose: vi.fn(),
        } as ActorVM,
      );
      const browseB = makeBrowse(['FromBrowseB']);

      let observedTypes: string[] = [];

      function Harness({ browse }: { browse: BrowseNamespace }) {
        const vm = useViewModel(() => createToyVM(browse));
        const types = useObservable(vm.entityTypes$) ?? [];
        observedTypes = types;
        return <div>{types.join(',')}</div>;
      }

      const { rerender } = render(<Harness browse={browseA} />);
      expect(deferredEmit).toHaveBeenCalled();

      // Swap to browseB while browseA's fetch is still pending.
      rerender(<Harness browse={browseB} />);
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

      // VM is still bound to browseA — so we never see browseB's value,
      // and browseA's fetch never completes. The UI is stuck at [].
      expect(observedTypes).toEqual([]);
    },
  );

  it(
    'DEAD-CACHE WRITE: if the stale browseA later receives a response, the value lands in an unobserved cache',
    async () => {
      // This test demonstrates the "fetch resolves into a cache nobody
      // reads" failure mode. Useful as a regression marker even though
      // it follows directly from the previous test's setup.
      const events$ = new Subject<BusEvent>();
      const pendingCids: string[] = [];
      const emit = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
        if (channel === 'browse:entity-types-requested') {
          pendingCids.push(payload.correlationId as string);
          // Don't respond yet — test resolves this manually.
        }
      });
      const browseA = new BrowseNamespace(
        {} as unknown as SemiontApiClient,
        new EventBus(),
        () => undefined,
        {
          on$<T>(channel: string) {
            return events$.pipe(filter((e) => e.channel === channel), map((e) => e.payload as T));
          },
          emit,
          state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
          addChannels: vi.fn(),
          removeChannels: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          dispose: vi.fn(),
        } as ActorVM,
      );
      const browseB = makeBrowse(NINE_TYPES);

      let observedTypes: string[] = [];
      function Harness({ browse }: { browse: BrowseNamespace }) {
        const vm = useViewModel(() => createToyVM(browse));
        const types = useObservable(vm.entityTypes$) ?? [];
        observedTypes = types;
        return <div>{types.join(',')}</div>;
      }

      const { rerender } = render(<Harness browse={browseA} />);
      expect(pendingCids.length).toBe(1);

      // Swap. VM still on browseA.
      rerender(<Harness browse={browseB} />);

      // Now resolve browseA's fetch — late. Nobody's listening.
      events$.next({
        channel: 'browse:entity-types-result',
        payload: { correlationId: pendingCids[0]!, response: { entityTypes: NINE_TYPES } },
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

      // VM is still pinned to browseA; that cache DID receive the value,
      // but the UI's VM observable was built BEFORE the swap and its
      // underlying client is browseA — so the UI still sees it. Actually
      // this one passes (the VM is bound to the cache that got the
      // write). The bug is only exposed by test #2 above where the live
      // client never gets queried.
      expect(observedTypes).toEqual(NINE_TYPES);
    },
  );
});
