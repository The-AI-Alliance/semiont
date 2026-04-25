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
import { BehaviorSubject, map } from 'rxjs';
import { EventBus } from '@semiont/core';
import { type ITransport, type IContentTransport } from '@semiont/core';
import { BrowseNamespace } from '@semiont/sdk';
import { useViewModel } from '../useViewModel';
import { useObservable } from '../useObservable';

const NINE_TYPES = [
  'Author', 'Concept', 'Date', 'Event', 'Location',
  'Organization', 'Person', 'Product', 'Technology',
];

/**
 * Build a minimal BrowseNamespace with a controllable mock transport. The
 * `answerEntityTypes` argument decides what the transport emits in response
 * to the next `browse:entity-types-requested`.
 */
function makeBrowse(answerEntityTypes: string[]) {
  const transportBus = new EventBus();
  const emit = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    if (channel === 'browse:entity-types-requested') {
      const correlationId = payload.correlationId as string;
      queueMicrotask(() => {
        (transportBus.get('browse:entity-types-result') as { next(v: unknown): void })
          .next({ correlationId, response: { entityTypes: answerEntityTypes } });
      });
    }
  });
  const transport = {
    emit,
    on: <K extends never>(channel: K, handler: (p: never) => void) => {
      const sub = (transportBus.get(channel) as { subscribe(fn: (p: never) => void): { unsubscribe(): void } }).subscribe(handler);
      return () => sub.unsubscribe();
    },
    stream: <K extends never>(channel: K) => transportBus.get(channel),
    subscribeToResource: vi.fn().mockReturnValue(() => {}),
    bridgeInto: vi.fn(),
    state$: new BehaviorSubject<'connected'>('connected').asObservable() as never,
    dispose: vi.fn(),
  } as unknown as ITransport;
  const content: IContentTransport = {
    putBinary: vi.fn(),
    getBinary: vi.fn(),
    getBinaryStream: vi.fn(),
    dispose: vi.fn(),
  };
  return new BrowseNamespace(transport, new EventBus(), content);
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
      const deferredTransportBus = new EventBus();
      const deferredEmit = vi.fn().mockImplementation(async () => { /* never answers */ });
      const deferredTransport = {
        emit: deferredEmit,
        on: <K extends never>(channel: K, handler: (p: never) => void) => {
          const sub = (deferredTransportBus.get(channel) as { subscribe(fn: (p: never) => void): { unsubscribe(): void } }).subscribe(handler);
          return () => sub.unsubscribe();
        },
        stream: <K extends never>(channel: K) => deferredTransportBus.get(channel),
        subscribeToResource: vi.fn().mockReturnValue(() => {}),
        bridgeInto: vi.fn(),
        state$: new BehaviorSubject<'connected'>('connected').asObservable() as never,
        dispose: vi.fn(),
      } as unknown as ITransport;
      const deferredContent: IContentTransport = {
        putBinary: vi.fn(),
        getBinary: vi.fn(),
        getBinaryStream: vi.fn(),
        dispose: vi.fn(),
      };
      const browseA = new BrowseNamespace(deferredTransport, new EventBus(), deferredContent);
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
      const transportBus = new EventBus();
      const pendingCids: string[] = [];
      const emit = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
        if (channel === 'browse:entity-types-requested') {
          pendingCids.push(payload.correlationId as string);
          // Don't respond yet — test resolves this manually.
        }
      });
      const transport = {
        emit,
        on: <K extends never>(channel: K, handler: (p: never) => void) => {
          const sub = (transportBus.get(channel) as { subscribe(fn: (p: never) => void): { unsubscribe(): void } }).subscribe(handler);
          return () => sub.unsubscribe();
        },
        stream: <K extends never>(channel: K) => transportBus.get(channel),
        subscribeToResource: vi.fn().mockReturnValue(() => {}),
        bridgeInto: vi.fn(),
        state$: new BehaviorSubject<'connected'>('connected').asObservable() as never,
        dispose: vi.fn(),
      } as unknown as ITransport;
      const content: IContentTransport = {
        putBinary: vi.fn(),
        getBinary: vi.fn(),
        getBinaryStream: vi.fn(),
        dispose: vi.fn(),
      };
      const browseA = new BrowseNamespace(transport, new EventBus(), content);
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
      (transportBus.get('browse:entity-types-result') as { next(v: unknown): void })
        .next({ correlationId: pendingCids[0]!, response: { entityTypes: NINE_TYPES } });
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
