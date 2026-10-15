/**
 * SemiontClient lifecycle + namespace-routing tests.
 *
 * Covers the wiring on `client.ts` itself: bus bridge construction,
 * `state$` / `dispose` plumbing, and two results that reach a caller with no
 * resource's scope held: a search's and an annotation's gather, each a
 * request answered on the wire.
 *
 * Strategy: pass a recording mock `ITransport` (and a mock
 * `IContentTransport`) into `new SemiontClient(...)`. No HTTP, no real
 * bus, no real KS — unit tests of the client-level wiring. The transport
 * contract itself is exercised by `local-transport.test.ts` and
 * `http-transport.http-paths.test.ts`. Each namespace's behavior is
 * exercised by its own suite under `namespaces/__tests__/`.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { BehaviorSubject, type Observable } from 'rxjs';
import {
  EventBus,
  baseUrl,
  resourceId,
  annotationId,
} from '@semiont/core';

import { SemiontClient } from '../client';
import type { ConnectionState, ITransport, IContentTransport } from '@semiont/core';
import { inMemoryTransport, gatewayOperationSpies, contentTransportSpies } from './helpers/in-memory-transport';

const TEST_BASE = baseUrl('http://test.local');

function makeMockTransport(wire: EventBus): ITransport {
  // Built through `inMemoryTransport` and then overridden with the spies these
  // tests assert on. The overrides are typed as the interface's own members
  // (`vi.fn<ITransport['emit']>()`), not bare `vi.fn()` — a bare spy types as
  // `Mock<Procedure>` and satisfies nothing, so it needs a cast, and a double
  // behind a cast drifts from the contract.
  const state$ = new BehaviorSubject<ConnectionState>('open');
  return {
    ...inMemoryTransport({ state$, bus: wire }),
    baseUrl: TEST_BASE,
    emit: vi.fn<ITransport['emit']>(async () => 1),
    subscribeToResource: vi.fn<ITransport['subscribeToResource']>(() => () => {}),
    bridgeInto: vi.fn<ITransport['bridgeInto']>(),
    dispose: vi.fn<ITransport['dispose']>(),
    ...gatewayOperationSpies(),
  };
}

function makeMockContent(): IContentTransport {
  return contentTransportSpies();
}

describe('SemiontClient lifecycle + namespace routing', () => {
  let transport: ITransport;
  /** What the transport delivers: a reply put here reaches the client as one off the wire does. */
  let wire: EventBus;
  let content: IContentTransport;
  let client: SemiontClient;

  beforeEach(() => {
    wire = new EventBus();
    transport = makeMockTransport(wire);
    content = makeMockContent();
    client = new SemiontClient(transport, content);
  });

  // ── Lifecycle / connection ─────────────────────────────────────────────
  describe('lifecycle', () => {
    test('state$ exposes the transport state observable', () => {
      // The mock starts in 'open'; flip it and ensure the client's
      // state$ reflects the change.
      const observed: ConnectionState[] = [];
      const sub = (transport.state$ as Observable<ConnectionState>).subscribe(() => { /* prime */ });
      sub.unsubscribe();
      const sub2 = client.state$.subscribe((s) => observed.push(s));
      (transport.state$ as BehaviorSubject<ConnectionState>).next('reconnecting');
      sub2.unsubscribe();
      expect(observed).toEqual(['open', 'reconnecting']);
    });

    test('dispose disposes both transport and content', () => {
      client.dispose();
      expect(transport.dispose).toHaveBeenCalled();
      expect(content.dispose).toHaveBeenCalled();
    });
  });

  // ── Bus disposal (A7-owned) ──────────────────────────────────────────────
  //
  // The client CONSTRUCTS its bus, so dispose() must destroy it (the
  // A7-owned rule — same shape as BrowseNamespace's caches, B16). A bus
  // that outlives its client keeps every subscriber attached forever,
  // silently receiving nothing (the L1 silence class), and a KB-reconnect
  // loop leaks one bus per session cycle. Bus lifetime == client lifetime;
  // whoever made the client ends it, after the session that used it.
  describe('bus disposal (A7-owned)', () => {
    test('dispose completes client.bus subscribers', () => {
      const events: string[] = [];
      client.bus.on('mark:submit').subscribe({
        next: () => events.push('next'),
        error: () => events.push('error'),
        complete: () => events.push('complete'),
      });

      client.dispose();

      expect(events).toEqual(['complete']);
    });

    test('unsubscribe after dispose is a safe no-op', () => {
      const sub = client.bus.on('mark:submit').subscribe(() => {});
      client.dispose();
      expect(() => sub.unsubscribe()).not.toThrow();
    });

    test('post-dispose bus access throws the destroyed-bus contract (loud, not silent)', () => {
      client.dispose();
      // Direct bus access and bus-emitting namespace methods alike: calling
      // a disposed client is a bug, and it says so rather than no-op'ing
      // into a leaked bus.
      expect(() => client.bus.on('mark:submit')).toThrow(/destroyed bus/);
      expect(() => client.mark.cancelPending()).toThrow(/destroyed bus/);
    });
  });

  const testResourceId = resourceId('test-resource-id');
  const testAnnotationId = annotationId('test-annotation-id');

  // ── Results without subscribeToResource ─────────────────────────────────
  //
  // `match.search()` and `gather.annotation()` return Observables that
  // resolve from a globally-delivered (un-scoped) result event keyed on
  // `correlationId`. They must work without the caller having called
  // `subscribeToResource(resourceId)` first.

  describe('results without subscribeToResource', () => {
    // A search and an annotation's gather are requests, answered on the
    // wire: each result is put on what the transport delivers, carrying no
    // resource's scope.

    test('client.match.search() resolves from a global match:search-results event', async () => {
      const { firstValueFrom } = await import('rxjs');
      const gathered = { sourceContext: {}, targetContext: {} } as never;
      const searchP = firstValueFrom(client.match.search(testResourceId, annotationId('ref-1'), gathered, { limit: 5 }));

      await Promise.resolve();
      const emitted = vi.mocked(transport.emit).mock.calls.find((c) => c[0] === 'match:search-requested');
      expect(emitted).toBeTruthy();
      const cid = emitted![2]?.correlationId;

      wire.emit('match:search-results', {
        referenceId: annotationId('ref-1'),
        response: [],
      }, { correlationId: cid });

      const result = await searchP;
      expect((result as { referenceId: string }).referenceId).toBe('ref-1');
      expect(transport.subscribeToResource).not.toHaveBeenCalled();
    });

    test('client.gather.annotation() resolves from a global gather:complete event', async () => {
      const { lastValueFrom } = await import('rxjs');
      const gatherP = lastValueFrom(
        client.gather.annotation(testResourceId, testAnnotationId, { contextWindow: 500 }),
      );

      await Promise.resolve();
      const emitted = vi.mocked(transport.emit).mock.calls.find((c) => c[0] === 'gather:requested');
      expect(emitted).toBeTruthy();
      const cid = emitted![2]?.correlationId;

      wire.emit('gather:complete', ({
        annotationId: testAnnotationId as unknown as string,
        response: { sourceContext: {} },
      }) as never, { correlationId: cid });

      const result = await gatherP;
      expect((result as { annotationId: string }).annotationId).toBe(testAnnotationId as unknown as string);
      expect(transport.subscribeToResource).not.toHaveBeenCalled();
    });

    test('a failed match:search-failed event resolves the Observable with an error', async () => {
      const { firstValueFrom } = await import('rxjs');
      const gathered = { sourceContext: {}, targetContext: {} } as never;
      const searchP = firstValueFrom(client.match.search(testResourceId, annotationId('ref-x'), gathered));

      await Promise.resolve();
      const cid = vi
        .mocked(transport.emit)
        .mock.calls.find((c) => c[0] === 'match:search-requested')![2]?.correlationId;

      wire.emit('match:search-failed', ({
        referenceId: 'ref-x',
        error: 'inference provider down',
      }) as never, { correlationId: cid });

      await expect(searchP).rejects.toThrow(/inference provider down/);
    });
  });

  // ── Connection state propagation through dispose semantics ──────────────
  describe('initialization', () => {
    test('SemiontClient construction calls transport.bridgeInto with its bus', () => {
      // bridgeInto is captured during construction (in beforeEach).
      expect(transport.bridgeInto).toHaveBeenCalledTimes(1);
      const arg = vi.mocked(transport.bridgeInto).mock.calls[0]![0];
      // Sanity: the argument is the same EventBus the client exposes.
      expect(arg).toBe(client.bus);
    });

    test('exposes baseUrl from the transport', () => {
      expect(client.baseUrl).toBe(TEST_BASE);
    });
  });
});
