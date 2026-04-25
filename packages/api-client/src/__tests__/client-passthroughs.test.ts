/**
 * SemiontClient passthrough tests.
 *
 * These exercise the methods on `client.ts` that delegate directly to
 * `this.transport` (auth, admin, exchange, system, lifecycle) and the
 * one bus-routed passthrough that isn't covered by the in-process
 * contract suite that lives next to its concrete transport
 * (`getAnnotation`).
 *
 * Strategy: pass a recording mock `ITransport` (and a mock
 * `IContentTransport`) into `new SemiontClient(...)`. No HTTP, no real
 * bus, no real KS — these are unit tests of the wiring on `client.ts`,
 * not transport behavior. The transport contract itself is exercised by
 * `local-transport.test.ts` (and, in the future, an HTTP runner).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { BehaviorSubject, Subject, type Observable } from 'rxjs';
import {
  baseUrl,
  email as makeEmail,
  entityType,
  googleCredential,
  jobId,
  refreshToken,
  resourceId,
  annotationId,
  userDID,
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

describe('SemiontClient passthrough wiring', () => {
  let transport: ITransport;
  let content: IContentTransport;
  let client: SemiontClient;

  beforeEach(() => {
    transport = makeMockTransport();
    content = makeMockContent();
    client = new SemiontClient(transport, content);
  });

  // ── Auth ────────────────────────────────────────────────────────────────
  describe('auth', () => {
    test('authenticatePassword forwards email + password', async () => {
      const reply = { access: 'a', refresh: 'r' };
      vi.mocked(transport.authenticatePassword).mockResolvedValue(reply as never);
      const result = await client.authenticatePassword(makeEmail('a@b'), 'pw');
      expect(transport.authenticatePassword).toHaveBeenCalledWith(makeEmail('a@b'), 'pw');
      expect(result).toEqual(reply);
    });

    test('refreshToken forwards to refreshAccessToken', async () => {
      const reply = { access: 'a2', refresh: 'r2' };
      vi.mocked(transport.refreshAccessToken).mockResolvedValue(reply as never);
      const result = await client.refreshToken(refreshToken('r-token'));
      expect(transport.refreshAccessToken).toHaveBeenCalledWith(refreshToken('r-token'));
      expect(result).toEqual(reply);
    });

    test('authenticateGoogle forwards the credential', async () => {
      const reply = { access: 'a3', refresh: 'r3' };
      vi.mocked(transport.authenticateGoogle).mockResolvedValue(reply as never);
      const result = await client.authenticateGoogle(googleCredential('g-cred'));
      expect(transport.authenticateGoogle).toHaveBeenCalledWith(googleCredential('g-cred'));
      expect(result).toEqual(reply);
    });

    test('getMediaToken forwards the resource id', async () => {
      vi.mocked(transport.getMediaToken).mockResolvedValue({ token: 'media-tok' });
      const id = resourceId('res-1');
      const result = await client.getMediaToken(id);
      expect(transport.getMediaToken).toHaveBeenCalledWith(id);
      expect(result).toEqual({ token: 'media-tok' });
    });

    test('getMe forwards to getCurrentUser', async () => {
      const user = { did: userDID('did:test:u'), email: 'a@b' };
      vi.mocked(transport.getCurrentUser).mockResolvedValue(user as never);
      const result = await client.getMe();
      expect(transport.getCurrentUser).toHaveBeenCalledWith();
      expect(result).toEqual(user);
    });

    test('acceptTerms calls transport.acceptTerms', async () => {
      vi.mocked(transport.acceptTerms).mockResolvedValue(undefined);
      await client.acceptTerms();
      expect(transport.acceptTerms).toHaveBeenCalled();
    });

    test('logout calls transport.logout', async () => {
      vi.mocked(transport.logout).mockResolvedValue(undefined);
      await client.logout();
      expect(transport.logout).toHaveBeenCalled();
    });
  });

  // ── Admin ───────────────────────────────────────────────────────────────
  describe('admin', () => {
    test('listUsers forwards to transport.listUsers', async () => {
      vi.mocked(transport.listUsers).mockResolvedValue({ users: [] } as never);
      const result = await client.listUsers();
      expect(transport.listUsers).toHaveBeenCalled();
      expect(result).toEqual({ users: [] });
    });

    test('getUserStats forwards to transport.getUserStats', async () => {
      vi.mocked(transport.getUserStats).mockResolvedValue({ count: 0 } as never);
      const result = await client.getUserStats();
      expect(transport.getUserStats).toHaveBeenCalled();
      expect(result).toEqual({ count: 0 });
    });

    test('updateUser forwards id + patch', async () => {
      const reply = { updated: true };
      vi.mocked(transport.updateUser).mockResolvedValue(reply as never);
      const id = userDID('did:test:victim');
      const patch = { isAdmin: true };
      const result = await client.updateUser(id, patch as never);
      expect(transport.updateUser).toHaveBeenCalledWith(id, patch);
      expect(result).toEqual(reply);
    });

    test('getOAuthConfig forwards to transport.getOAuthConfig', async () => {
      vi.mocked(transport.getOAuthConfig).mockResolvedValue({ google: { clientId: 'x' } } as never);
      const result = await client.getOAuthConfig();
      expect(transport.getOAuthConfig).toHaveBeenCalled();
      expect(result).toEqual({ google: { clientId: 'x' } });
    });
  });

  // ── Exchange ────────────────────────────────────────────────────────────
  describe('exchange', () => {
    test('backupKnowledgeBase forwards', async () => {
      const r = new Response(new Blob(['b']));
      vi.mocked(transport.backupKnowledgeBase).mockResolvedValue(r);
      const result = await client.backupKnowledgeBase();
      expect(transport.backupKnowledgeBase).toHaveBeenCalled();
      expect(result).toBe(r);
    });

    test('restoreKnowledgeBase forwards file + onProgress', async () => {
      const file = new File(['x'], 'x.tgz');
      const onProgress = vi.fn();
      vi.mocked(transport.restoreKnowledgeBase).mockResolvedValue({ phase: 'done' } as never);
      await client.restoreKnowledgeBase(file, { onProgress });
      expect(transport.restoreKnowledgeBase).toHaveBeenCalledWith(file, onProgress);
    });

    test('exportKnowledgeBase forwards params', async () => {
      const r = new Response(new Blob(['e']));
      vi.mocked(transport.exportKnowledgeBase).mockResolvedValue(r);
      const result = await client.exportKnowledgeBase({ includeArchived: true });
      expect(transport.exportKnowledgeBase).toHaveBeenCalledWith({ includeArchived: true });
      expect(result).toBe(r);
    });

    test('importKnowledgeBase forwards file + onProgress', async () => {
      const file = new File(['i'], 'i.tgz');
      const onProgress = vi.fn();
      vi.mocked(transport.importKnowledgeBase).mockResolvedValue({ phase: 'done' } as never);
      await client.importKnowledgeBase(file, { onProgress });
      expect(transport.importKnowledgeBase).toHaveBeenCalledWith(file, onProgress);
    });
  });

  // ── System ──────────────────────────────────────────────────────────────
  describe('system', () => {
    test('healthCheck forwards', async () => {
      vi.mocked(transport.healthCheck).mockResolvedValue({ status: 'ok' } as never);
      const result = await client.healthCheck();
      expect(transport.healthCheck).toHaveBeenCalled();
      expect(result).toEqual({ status: 'ok' });
    });

    test('getStatus forwards', async () => {
      vi.mocked(transport.getStatus).mockResolvedValue({ status: 'running' } as never);
      const result = await client.getStatus();
      expect(transport.getStatus).toHaveBeenCalled();
      expect(result).toEqual({ status: 'running' });
    });
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

  // ── Bus passthrough — getAnnotation ─────────────────────────────────────
  describe('getAnnotation (bus passthrough)', () => {
    test('emits browse:annotation-requested and resolves on result', async () => {
      const aId = annotationId('ann-1');
      // Drive the bus: when client emits, push a matching result.
      const emit = vi.mocked(transport.emit) as unknown as ReturnType<typeof vi.fn>;
      const stream = vi.mocked(transport.stream);
      // Build a result subject we control so we can deliver after the emit.
      const resultSubject = new Subject<{ correlationId: string; response: unknown }>();
      const failedSubject = new Subject<{ correlationId: string; message: string }>();
      stream.mockImplementation((channel: string) => {
        if (channel === 'browse:annotation-result') return resultSubject.asObservable() as never;
        if (channel === 'browse:annotation-failed') return failedSubject.asObservable() as never;
        return new Subject<never>().asObservable() as never;
      });

      let capturedCorrelationId = '';
      emit.mockImplementation(async (_channel, payload) => {
        capturedCorrelationId = (payload as Record<string, unknown>).correlationId as string;
      });

      const promise = client.getAnnotation(aId);
      // Wait a microtask so busRequest's emit completes before we deliver.
      await Promise.resolve();
      resultSubject.next({
        correlationId: capturedCorrelationId,
        response: { annotation: { id: aId, motivation: 'highlighting' } },
      });

      const result = await promise;
      expect(emit).toHaveBeenCalledWith(
        'browse:annotation-requested',
        expect.objectContaining({ annotationId: aId, correlationId: capturedCorrelationId }),
      );
      expect(result).toEqual({ annotation: { id: aId, motivation: 'highlighting' } });
    });
  });

  // ── Other bus methods (smoke test forwarding shape) ────────────────────
  describe('bus emits from client', () => {
    test('addEntityType emits mark:add-entity-type with the tag', async () => {
      await client.addEntityType(entityType('Person'));
      expect(transport.emit).toHaveBeenCalledWith('mark:add-entity-type', { tag: entityType('Person') });
    });

    test('matchSearch emits match:search-requested with the supplied data', async () => {
      const rId = resourceId('r-1');
      const correlationId = 'cid-1';
      await client.matchSearch(rId, {
        correlationId,
        referenceId: 'ref-1',
        context: { foo: 'bar' },
        limit: 5,
        useSemanticScoring: false,
      });
      expect(transport.emit).toHaveBeenCalledWith('match:search-requested', {
        correlationId,
        resourceId: rId,
        referenceId: 'ref-1',
        context: { foo: 'bar' },
        limit: 5,
        useSemanticScoring: false,
      });
    });

    test('beckonAttention emits beckon:focus with the data', async () => {
      const data = { resourceId: 'r-1', annotationId: 'a-1', message: 'hey' };
      await client.beckonAttention('participant-1', data);
      expect(transport.emit).toHaveBeenCalledWith('beckon:focus', data);
    });
  });

  // ── Job status — exercises busRequest path on jobId ─────────────────────
  describe('getJobStatus', () => {
    test('emits job:status-requested and resolves on job:status-result', async () => {
      const id = jobId('job-1');
      const stream = vi.mocked(transport.stream);
      const result$ = new Subject<{ correlationId: string; response: unknown }>();
      const failed$ = new Subject<{ correlationId: string; message: string }>();
      stream.mockImplementation((channel: string) => {
        if (channel === 'job:status-result') return result$.asObservable() as never;
        if (channel === 'job:status-failed') return failed$.asObservable() as never;
        return new Subject<never>().asObservable() as never;
      });

      let cid = '';
      vi.mocked(transport.emit).mockImplementation(async (_channel, payload) => {
        cid = (payload as { correlationId: string }).correlationId;
      });

      const promise = client.getJobStatus(id);
      await Promise.resolve();
      result$.next({ correlationId: cid, response: { status: 'complete' } });

      const result = await promise;
      expect(transport.emit).toHaveBeenCalledWith(
        'job:status-requested',
        expect.objectContaining({ jobId: id }),
      );
      expect(result).toEqual({ status: 'complete' });
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
