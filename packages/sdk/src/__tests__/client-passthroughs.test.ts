/**
 * SemiontClient lifecycle + namespace-routing tests.
 *
 * Covers the wiring on `client.ts` itself: bus bridge construction,
 * `state$` / `subscribeToResource` / `dispose` plumbing, and the few
 * namespace flows that resolve via the bridged `client.bus` rather than
 * `transport.stream` directly (match.search, gather.annotation).
 *
 * Strategy: pass a recording mock `ITransport` (and a mock
 * `IContentTransport`) into `new SemiontClient(...)`. No HTTP, no real
 * bus, no real KS — unit tests of the client-level wiring. The transport
 * contract itself is exercised by `local-transport.test.ts` and
 * `http-transport.http-paths.test.ts`. Each namespace's behavior is
 * exercised by its own suite under `namespaces/__tests__/`.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { BehaviorSubject, Subject, type Observable } from 'rxjs';
import {
  baseUrl,
  resourceId,
  annotationId,
  type EventMap,
} from '@semiont/core';

import { SemiontClient } from '../client';
import type { ConnectionState, ITransport, IContentTransport } from '@semiont/core';

const TEST_BASE = baseUrl('http://test.local');

function makeMockTransport(): ITransport {
  const state$ = new BehaviorSubject<ConnectionState>('open');
  const eventSubjects = new Map<string, Subject<unknown>>();
  const getSubject = (channel: string): Subject<unknown> => {
    if (!eventSubjects.has(channel)) eventSubjects.set(channel, new Subject<unknown>());
    return eventSubjects.get(channel)!;
  };

  return {
    baseUrl: TEST_BASE,
    state$,
    emit: vi.fn(async () => {}),
    on: vi.fn((channel: string, handler: (p: unknown) => void) => {
      const sub = getSubject(channel).subscribe(handler);
      return () => sub.unsubscribe();
    }) as unknown as ITransport['on'],
    stream: vi.fn(<K extends keyof EventMap>(channel: K) =>
      getSubject(channel as string).asObservable() as unknown as Observable<EventMap[K]>,
    ),
    subscribeToResource: vi.fn(() => () => {}),
    bridgeInto: vi.fn(),
    authenticatePassword: vi.fn(),
    authenticateGoogle: vi.fn(),
    refreshAccessToken: vi.fn(),
    logout: vi.fn(),
    acceptTerms: vi.fn(),
    getCurrentUser: vi.fn(),
    generateMcpToken: vi.fn(),
    getMediaToken: vi.fn(),
    listUsers: vi.fn(),
    getUserStats: vi.fn(),
    updateUser: vi.fn(),
    getOAuthConfig: vi.fn(),
    backupKnowledgeBase: vi.fn(),
    restoreKnowledgeBase: vi.fn(),
    exportKnowledgeBase: vi.fn(),
    importKnowledgeBase: vi.fn(),
    healthCheck: vi.fn(),
    getStatus: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ITransport;
}

function makeMockContent(): IContentTransport {
  return {
    putBinary: vi.fn(),
    getBinary: vi.fn(),
    getBinaryStream: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('SemiontClient lifecycle + namespace routing', () => {
  let transport: ITransport;
  let content: IContentTransport;
  let client: SemiontClient;

  beforeEach(() => {
    transport = makeMockTransport();
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

    test('subscribeToResource forwards the resource id', () => {
      const id = resourceId('res-x');
      const disposer = client.subscribeToResource(id);
      expect(transport.subscribeToResource).toHaveBeenCalledWith(id);
      // Returned disposer should not throw when called.
      expect(disposer).toBeInstanceOf(Function);
      disposer();
    });

    test('dispose disposes both transport and content', () => {
      client.dispose();
      expect(transport.dispose).toHaveBeenCalled();
      expect(content.dispose).toHaveBeenCalled();
    });
  });

  const testResourceId = resourceId('test-resource-id');
  const testAnnotationId = annotationId('test-annotation-id');

  // ── SIMPLE-BUS gap #1: results without subscribeToResource ──────────────
  //
  // `match.search()` and `gather.annotation()` return Observables that
  // resolve from a globally-delivered (un-scoped) result event keyed on
  // `correlationId`. They must work without the caller having called
  // `subscribeToResource(resourceId)` first.

  describe('results without subscribeToResource', () => {
    // Match/gather Observables read from `client.bus` (the bridged surface),
    // not from `transport.stream` directly. To simulate a global result
    // arriving without a resource scope, push onto `client.bus` directly —
    // this is what the transport bridge would do on a real wire.

    test('client.match.search() resolves from a global match:search-results event', async () => {
      const { firstValueFrom } = await import('rxjs');
      const gathered = { sourceContext: {}, targetContext: {} } as never;
      const searchP = firstValueFrom(client.match.search(testResourceId, annotationId('ref-1'), gathered, { limit: 5 }));

      await Promise.resolve();
      const emitted = vi.mocked(transport.emit).mock.calls.find((c) => c[0] === 'match:search-requested');
      expect(emitted).toBeTruthy();
      const cid = (emitted![1] as { correlationId: string }).correlationId;

      (client.bus.get('match:search-results') as unknown as Subject<unknown>).next({
        correlationId: cid,
        referenceId: 'ref-1',
        response: [],
      });

      const result = await searchP;
      expect((result as { correlationId: string }).correlationId).toBe(cid);
      expect(transport.subscribeToResource).not.toHaveBeenCalled();
    });

    test('client.gather.annotation() resolves from a global gather:complete event', async () => {
      const { lastValueFrom } = await import('rxjs');
      const gatherP = lastValueFrom(
        client.gather.annotation(testAnnotationId, testResourceId, { contextWindow: 500 }),
      );

      await Promise.resolve();
      const emitted = vi.mocked(transport.emit).mock.calls.find((c) => c[0] === 'gather:requested');
      expect(emitted).toBeTruthy();
      const cid = (emitted![1] as { correlationId: string }).correlationId;

      (client.bus.get('gather:complete') as unknown as Subject<unknown>).next({
        correlationId: cid,
        annotationId: testAnnotationId as unknown as string,
        response: { sourceContext: {} },
      });

      const result = await gatherP;
      expect((result as { correlationId: string }).correlationId).toBe(cid);
      expect(transport.subscribeToResource).not.toHaveBeenCalled();
    });

    test('a failed match:search-failed event resolves the Observable with an error', async () => {
      const { firstValueFrom } = await import('rxjs');
      const gathered = { sourceContext: {}, targetContext: {} } as never;
      const searchP = firstValueFrom(client.match.search(testResourceId, annotationId('ref-x'), gathered));

      await Promise.resolve();
      const cid = (vi.mocked(transport.emit).mock.calls.find((c) => c[0] === 'match:search-requested')![1] as {
        correlationId: string;
      }).correlationId;

      (client.bus.get('match:search-failed') as unknown as Subject<unknown>).next({
        correlationId: cid,
        referenceId: 'ref-x',
        error: 'inference provider down',
      });

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
