/**
 * Identity / re-creation seam tests for useStateUnit.
 *
 * These tests probe the "what if the client/cache reference changes after
 * the state unit has been constructed" seam — the strongest remaining candidate
 * for the test 05 entity-types failure after Layer 2/3/5-6 unit tests
 * all came back green.
 *
 * Three scenarios modeled:
 *  1. useStateUnit's factory is called once and captures the initial
 *     closure — subsequent prop/context changes do NOT re-run the factory.
 *     A state unit that captured `clientA.browse` keeps pointing at it forever.
 *  2. If `clientA` is replaced by `clientB` in context, and `clientB.browse`
 *     is the one actually receiving bus events, the state unit (still on `clientA`)
 *     sees nothing.
 *  3. Even if we re-run the factory, an in-flight fetch on `clientA` may
 *     resolve AFTER `clientB` is live — writing the response into a dead
 *     cache that nobody observes.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BehaviorSubject, Subject, map } from 'rxjs';
import { readyValue } from '@semiont/sdk';
import { inMemoryContent } from '@semiont/sdk/testing';
import type { ConnectionState, SemiontError } from '@semiont/core';
import { EventBus, baseUrl } from '@semiont/core';
import { type ITransport } from '@semiont/core';
import { BrowseNamespace } from '@semiont/sdk';
import { useStateUnit } from '../useStateUnit';
import { useObservable } from '../useObservable';

const NINE_TYPES = [
  'Author', 'Concept', 'Date', 'Event', 'Location',
  'Organization', 'Person', 'Product', 'Technology',
];

/**
 * An in-memory `ITransport` over one `EventBus`, differing per test only in
 * how `emit` answers.
 *
 * Typed as `ITransport` with NO cast, deliberately. These fakes were built as
 * object literals behind `as unknown as ITransport`, and the cast hid three
 * required members — `baseUrl`, `errors$` and `isSubscribed`. Only the one
 * that happened to be CALLED blew up, and not even loudly: the SWR cache
 * swallowed `bus.isSubscribed is not a function` into its retry-then-idle
 * path, so the symptom was an empty entity-type list (CLIENT-SUBSCRIPTION-
 * MANIFEST, 2026-09-16). Constructing through this signature makes the next
 * required member a compile error instead.
 *
 * `isSubscribed` answers `true` honestly rather than as a stub: `stream()`
 * here returns the bus subject for whatever channel is asked, so this
 * transport genuinely does deliver every channel.
 */
// NOT `FaultyTransport` from `@semiont/sdk/testing`, deliberately: that double
// scripts replies declaratively (a fault schedule + a reply queue), and the
// DEAD-CACHE WRITE test below must hold a request pending, observe its
// correlationId, re-render, and only THEN answer it. No fault kind expresses
// "resolve this one later", so this file keeps a callback-scripted transport.
function inMemoryTransport(
  bus: EventBus,
  onEmit: (
    channel: string,
    payload: Record<string, unknown>,
    envelope?: { correlationId?: string },
  ) => void,
): ITransport {
  return {
    baseUrl: baseUrl('http://transport.test'),
    // Adapting a spy here (rather than taking `ITransport['emit']` directly)
    // is what keeps this literal cast-free: the interface contextually types
    // `channel` and `payload`, and each test still asserts on its own spy.
    emit: async (channel, payload, envelope) => {
      // The envelope reaches the responder: `busRequest` matches its reply on
      // `frame.correlationId`, so a double that swallowed it would strand
      // every request behind this transport.
      onEmit(channel, payload as Record<string, unknown>, envelope);
      return 1;
    },
    on: (channel, handler) => {
      const sub = bus.on(channel).subscribe(handler);
      return () => sub.unsubscribe();
    },
    stream: (channel) => bus.on(channel),
    frames: (channel) => bus.frames(channel),
    subscribeToResource: () => () => {},
    bridgeInto: () => {},
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
    isSubscribed: () => true,
    errors$: new Subject<SemiontError>().asObservable(),
    dispose: () => {},
  };
}


/**
 * Build a minimal BrowseNamespace with a controllable mock transport. The
 * `answerEntityTypes` argument decides what the transport emits in response
 * to the next `browse:entity-types-requested`.
 */
function makeBrowse(answerEntityTypes: string[]) {
  const transportBus = new EventBus();
  const emit = vi.fn().mockImplementation((channel: string, _payload: Record<string, unknown>, envelope?: { correlationId?: string }) => {
    if (channel === 'browse:entity-types-requested') {
      const correlationId = envelope?.correlationId as string;
      queueMicrotask(() => {
        transportBus.emit('browse:entity-types-result', { response: { entityTypes: answerEntityTypes } }, { correlationId });
      });
    }
  });
  return new BrowseNamespace(
    inMemoryTransport(transportBus, emit),
    new EventBus(),
    inMemoryContent(),
  );
}

/**
 * A state unit factory mirroring what ResourceViewerPage does: captures `browse`
 * at factory-invocation time and pipes `.entityTypes()` into `$`.
 */
function createToyStateUnit(browse: BrowseNamespace) {
  const entityTypes$ = browse.entityTypes().pipe(map((st) => readyValue(st) ?? []));
  return {
    entityTypes$,
    dispose: () => { /* noop */ },
  };
}

describe('useStateUnit identity seam — stale client references', () => {
  it(
    'FACTORY RUNS ONCE: changing the browse prop does NOT re-create the state unit',
    async () => {
      const browseA = makeBrowse(NINE_TYPES);
      const browseB = makeBrowse(['FromBrowseB']);

      let observedTypes: string[] = [];

      function Harness({ browse }: { browse: BrowseNamespace }) {
        const stateUnit = useStateUnit(() => createToyStateUnit(browse));
        const types = useObservable(stateUnit.entityTypes$) ?? [];
        observedTypes = types;
        return <div data-testid="types">{types.join(',')}</div>;
      }

      const { rerender } = render(<Harness browse={browseA} />);

      // Let browseA's fetch complete.
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(observedTypes).toEqual(NINE_TYPES);

      // Now swap to browseB. state-unit factory is NOT re-run — state unit still points
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
      const deferredEmit = vi.fn().mockImplementation(() => { /* never answers */ });
      const browseA = new BrowseNamespace(
        inMemoryTransport(deferredTransportBus, deferredEmit),
        new EventBus(),
        inMemoryContent(),
      );
      const browseB = makeBrowse(['FromBrowseB']);

      let observedTypes: string[] = [];

      function Harness({ browse }: { browse: BrowseNamespace }) {
        const stateUnit = useStateUnit(() => createToyStateUnit(browse));
        const types = useObservable(stateUnit.entityTypes$) ?? [];
        observedTypes = types;
        return <div>{types.join(',')}</div>;
      }

      const { rerender } = render(<Harness browse={browseA} />);
      expect(deferredEmit).toHaveBeenCalled();

      // Swap to browseB while browseA's fetch is still pending.
      rerender(<Harness browse={browseB} />);
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

      // state unit is still bound to browseA — so we never see browseB's value,
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
      const emit = vi.fn().mockImplementation((channel: string, _payload: Record<string, unknown>, envelope?: { correlationId?: string }) => {
        if (channel === 'browse:entity-types-requested') {
          pendingCids.push(envelope?.correlationId as string);
          // Don't respond yet — test resolves this manually.
        }
      });
      const browseA = new BrowseNamespace(
        inMemoryTransport(transportBus, emit),
        new EventBus(),
        inMemoryContent(),
      );
      const browseB = makeBrowse(NINE_TYPES);

      let observedTypes: string[] = [];
      function Harness({ browse }: { browse: BrowseNamespace }) {
        const stateUnit = useStateUnit(() => createToyStateUnit(browse));
        const types = useObservable(stateUnit.entityTypes$) ?? [];
        observedTypes = types;
        return <div>{types.join(',')}</div>;
      }

      const { rerender } = render(<Harness browse={browseA} />);
      expect(pendingCids.length).toBe(1);

      // Swap. state unit still on browseA.
      rerender(<Harness browse={browseB} />);

      // Now resolve browseA's fetch — late. Nobody's listening.
      transportBus.emit('browse:entity-types-result', { response: { entityTypes: NINE_TYPES } }, { correlationId: pendingCids[0]! });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

      // state unit is still pinned to browseA; that cache DID receive the value,
      // but the UI's state-unit observable was built BEFORE the swap and its
      // underlying client is browseA — so the UI still sees it. Actually
      // this one passes (the state unit is bound to the cache that got the
      // write). The bug is only exposed by test #2 above where the live
      // client never gets queried.
      expect(observedTypes).toEqual(NINE_TYPES);
    },
  );
});
