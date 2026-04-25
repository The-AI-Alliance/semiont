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

  // ── Bus busRequest passthroughs (channel name + payload shape) ──────────
  //
  // Pattern: every method emits a request channel with the right payload
  // shape, then resolves when a matching `correlationId` arrives on the
  // result channel. We assert on the emit and feed back a result.

  /** Helper: capture the emitted correlationId, then push a result. */
  function setBusResponse(
    requestChannel: string,
    resultChannel: string,
    response: Record<string, unknown>,
  ) {
    const eventSubjects = (transport as unknown as { __subjects?: Map<string, Subject<unknown>> }).__subjects;
    const resultSubject = new Subject<{ correlationId: string; response: unknown }>();
    vi.mocked(transport.stream).mockImplementation((ch: string) => {
      if (ch === resultChannel) return resultSubject.asObservable() as never;
      // Fall through to default subjects for failure/other channels.
      const m = eventSubjects;
      if (m) {
        if (!m.has(ch)) m.set(ch, new Subject<unknown>());
        return m.get(ch)!.asObservable() as never;
      }
      return new Subject<never>().asObservable() as never;
    });
    (transport.emit as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === requestChannel) {
        queueMicrotask(() => {
          resultSubject.next({ correlationId: payload.correlationId as string, response });
        });
      }
    });
  }

  const testResourceId = resourceId('test-resource-id');
  const testAnnotationId = annotationId('test-annotation-id');

  describe('browseResource (bus)', () => {
    test('emits browse:resource-requested and returns result', async () => {
      setBusResponse('browse:resource-requested', 'browse:resource-result', {
        resource: { '@id': testResourceId, name: 'Test' },
      });
      const result = await client.browseResource(testResourceId);
      expect(transport.emit).toHaveBeenCalledWith(
        'browse:resource-requested',
        expect.objectContaining({ resourceId: testResourceId }),
      );
      expect((result as { resource: { name: string } }).resource.name).toBe('Test');
    });
  });

  describe('browseResources (bus)', () => {
    test('emits browse:resources-requested with filters', async () => {
      setBusResponse('browse:resources-requested', 'browse:resources-result', { resources: [], total: 0 });
      await client.browseResources(10, false);
      expect(transport.emit).toHaveBeenCalledWith(
        'browse:resources-requested',
        expect.objectContaining({ limit: 10, archived: false }),
      );
    });
  });

  describe('getResourceEvents (bus)', () => {
    test('emits browse:events-requested and returns events', async () => {
      setBusResponse('browse:events-requested', 'browse:events-result', { events: [], total: 0 });
      const result = await client.getResourceEvents(testResourceId);
      expect((result as { events: unknown[] }).events).toEqual([]);
    });
  });

  describe('browseReferences (bus)', () => {
    test('emits browse:referenced-by-requested', async () => {
      setBusResponse('browse:referenced-by-requested', 'browse:referenced-by-result', { referencedBy: [] });
      await client.browseReferences(testResourceId);
      expect(transport.emit).toHaveBeenCalledWith(
        'browse:referenced-by-requested',
        expect.objectContaining({ resourceId: testResourceId }),
      );
    });
  });

  describe('browseAnnotation / browseAnnotations (bus)', () => {
    test('browseAnnotation emits browse:annotation-requested', async () => {
      setBusResponse('browse:annotation-requested', 'browse:annotation-result', { annotation: {} });
      await client.browseAnnotation(testResourceId, testAnnotationId);
      expect(transport.emit).toHaveBeenCalledWith(
        'browse:annotation-requested',
        expect.objectContaining({ resourceId: testResourceId, annotationId: testAnnotationId }),
      );
    });

    test('browseAnnotations emits browse:annotations-requested', async () => {
      setBusResponse('browse:annotations-requested', 'browse:annotations-result', { annotations: [] });
      await client.browseAnnotations(testResourceId);
      expect(transport.emit).toHaveBeenCalledWith(
        'browse:annotations-requested',
        expect.objectContaining({ resourceId: testResourceId }),
      );
    });
  });

  describe('getAnnotationHistory (bus)', () => {
    test('emits browse:annotation-history-requested', async () => {
      setBusResponse('browse:annotation-history-requested', 'browse:annotation-history-result', { events: [] });
      await client.getAnnotationHistory(testResourceId, testAnnotationId);
      expect(transport.emit).toHaveBeenCalledWith(
        'browse:annotation-history-requested',
        expect.objectContaining({ resourceId: testResourceId, annotationId: testAnnotationId }),
      );
    });
  });

  describe('listEntityTypes (bus)', () => {
    test('emits browse:entity-types-requested', async () => {
      setBusResponse('browse:entity-types-requested', 'browse:entity-types-result', { entityTypes: ['Person'] });
      const result = await client.listEntityTypes();
      expect((result as { entityTypes: string[] }).entityTypes).toEqual(['Person']);
    });
  });

  describe('browseFiles (bus)', () => {
    test('emits browse:directory-requested with path and sort', async () => {
      setBusResponse('browse:directory-requested', 'browse:directory-result', { files: [] });
      await client.browseFiles('docs', 'mtime');
      expect(transport.emit).toHaveBeenCalledWith(
        'browse:directory-requested',
        expect.objectContaining({ path: 'docs', sort: 'mtime' }),
      );
    });
  });

  describe('job-creating commands (bus)', () => {
    test('annotateReferences emits job:create with reference-annotation type', async () => {
      setBusResponse('job:create', 'job:created', { jobId: 'j1' });
      const result = await client.annotateReferences(testResourceId, { entityTypes: ['Person'] });
      expect(transport.emit).toHaveBeenCalledWith(
        'job:create',
        expect.objectContaining({
          jobType: 'reference-annotation',
          resourceId: testResourceId,
          params: { entityTypes: ['Person'] },
        }),
      );
      expect(result.jobId).toBe('j1');
    });

    test('annotateHighlights emits job:create with highlight-annotation type', async () => {
      setBusResponse('job:create', 'job:created', { jobId: 'j1' });
      await client.annotateHighlights(testResourceId, { density: 5 });
      expect(transport.emit).toHaveBeenCalledWith(
        'job:create',
        expect.objectContaining({ jobType: 'highlight-annotation' }),
      );
    });

    test('annotateTags emits job:create with tag-annotation type', async () => {
      setBusResponse('job:create', 'job:created', { jobId: 'j1' });
      await client.annotateTags(testResourceId, { schemaId: 's1', categories: ['a'] });
      expect(transport.emit).toHaveBeenCalledWith(
        'job:create',
        expect.objectContaining({ jobType: 'tag-annotation' }),
      );
    });

    test('yieldResourceFromAnnotation emits job:create with generation type', async () => {
      setBusResponse('job:create', 'job:created', { jobId: 'j1' });
      await client.yieldResourceFromAnnotation(testResourceId, testAnnotationId, {
        title: 'T',
        storageUri: 'file://x',
        context: {},
      });
      expect(transport.emit).toHaveBeenCalledWith(
        'job:create',
        expect.objectContaining({
          jobType: 'generation',
          resourceId: testResourceId,
          params: expect.objectContaining({ referenceId: testAnnotationId }),
        }),
      );
    });
  });

  describe('clone token flows (bus)', () => {
    test('generateCloneToken emits yield:clone-token-requested', async () => {
      setBusResponse('yield:clone-token-requested', 'yield:clone-token-generated', {
        token: 'tok',
        expiresAt: '2026-01-01',
      });
      const result = await client.generateCloneToken(testResourceId);
      expect((result as { token: string }).token).toBe('tok');
    });

    test('getResourceByToken emits yield:clone-resource-requested', async () => {
      setBusResponse('yield:clone-resource-requested', 'yield:clone-resource-result', {
        sourceResource: { name: 'src' },
      });
      const ct = await import('@semiont/core').then((m) => m.cloneToken);
      const result = await client.getResourceByToken(ct('tok-1'));
      expect((result as { sourceResource: { name: string } }).sourceResource.name).toBe('src');
    });

    test('createResourceFromToken emits yield:clone-create', async () => {
      setBusResponse('yield:clone-create', 'yield:clone-created', { resourceId: 'res-new' });
      const result = await client.createResourceFromToken({ token: 'tok', name: 'new', content: 'c' });
      expect(result.resourceId).toBe('res-new');
    });
  });

  describe('annotation creation (bus)', () => {
    test('markAnnotation emits mark:create-request and returns annotationId', async () => {
      setBusResponse('mark:create-request', 'mark:create-ok', { annotationId: 'ann-new' });
      const result = await client.markAnnotation(testResourceId, {
        motivation: 'highlighting',
        target: { source: testResourceId },
      } as never);
      expect(result.annotationId).toBe('ann-new');
      expect(transport.emit).toHaveBeenCalledWith(
        'mark:create-request',
        expect.objectContaining({ resourceId: testResourceId }),
      );
    });
  });

  // ── Bus fire-and-forget extensions ──────────────────────────────────────

  describe('fire-and-forget bus commands (extended)', () => {
    test('deleteAnnotation emits mark:delete', async () => {
      await client.deleteAnnotation(testResourceId, testAnnotationId);
      expect(transport.emit).toHaveBeenCalledWith('mark:delete', {
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    test('addEntityTypesBulk emits one event per tag', async () => {
      await client.addEntityTypesBulk([entityType('Person'), entityType('Place')]);
      expect(transport.emit).toHaveBeenCalledTimes(2);
      expect(transport.emit).toHaveBeenNthCalledWith(1, 'mark:add-entity-type', { tag: 'Person' });
      expect(transport.emit).toHaveBeenNthCalledWith(2, 'mark:add-entity-type', { tag: 'Place' });
    });

    test('bindAnnotation emits bind:update-body with correlationId', async () => {
      const result = await client.bindAnnotation(testResourceId, testAnnotationId, {
        operations: [{ op: 'add', item: { type: 'SpecificResource', source: 'r' } }],
      });
      expect(transport.emit).toHaveBeenCalledWith(
        'bind:update-body',
        expect.objectContaining({
          annotationId: testAnnotationId,
          resourceId: testResourceId,
          operations: expect.any(Array),
        }),
      );
      expect(result.correlationId).toMatch(/^[a-f0-9-]+$/);
    });

    test('gatherAnnotationContext emits gather:requested', async () => {
      await client.gatherAnnotationContext(testResourceId, testAnnotationId, {
        correlationId: 'c1',
        contextWindow: 500,
      });
      expect(transport.emit).toHaveBeenCalledWith(
        'gather:requested',
        expect.objectContaining({
          correlationId: 'c1',
          options: expect.objectContaining({ contextWindow: 500 }),
          annotationId: testAnnotationId,
          resourceId: testResourceId,
        }),
      );
    });
  });

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
      const searchP = firstValueFrom(client.match.search(testResourceId, 'ref-1', gathered, { limit: 5 }));

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
      const searchP = firstValueFrom(client.match.search(testResourceId, 'ref-x', gathered));

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
