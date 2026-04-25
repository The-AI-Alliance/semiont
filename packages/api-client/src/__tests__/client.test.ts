import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { KyInstance } from 'ky';

vi.mock('ky', () => ({
  default: {
    create: vi.fn(),
  },
}));

const actorHarness = {
  emitSpy: vi.fn(),
  events$: null as unknown as import('rxjs').Subject<{ channel: string; payload: Record<string, unknown> }>,
  start: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
  addChannels: vi.fn(),
  removeChannels: vi.fn(),
};

vi.mock('../view-models/domain/actor-vm', async () => {
  const { BehaviorSubject, Subject } = await import('rxjs');
  const { filter, map } = await import('rxjs/operators');
  return {
    createActorVM: () => {
      const events$ = new Subject<{ channel: string; payload: Record<string, unknown> }>();
      actorHarness.events$ = events$;
      actorHarness.emitSpy = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
        const handler = (actorHarness as any).onEmit as ((c: string, p: Record<string, unknown>) => void) | undefined;
        if (handler) handler(channel, payload);
      });
      return {
        on$: <T,>(channel: string) => events$.pipe(filter((e) => e.channel === channel), map((e) => e.payload as T)),
        emit: actorHarness.emitSpy,
        state$: new BehaviorSubject<string>('open').asObservable(),
        addChannels: actorHarness.addChannels,
        removeChannels: actorHarness.removeChannels,
        start: actorHarness.start,
        stop: actorHarness.stop,
        dispose: actorHarness.dispose,
      };
    },
  };
});

import ky from 'ky';
import { SemiontClient } from '../client';
import { HttpTransport } from '../transport/http-transport';
import { HttpContentTransport } from '../transport/http-content-transport';
import type { ContentFormat } from '@semiont/core';
import { baseUrl, resourceId, annotationId, jobId, cloneToken, entityType } from '@semiont/core';

describe('SemiontClient', () => {
  let client: SemiontClient;
  let mockKy: KyInstance;
  const testBaseUrl = baseUrl('http://localhost:4000');
  const testResourceId = resourceId('test-resource-id');
  const testAnnotationId = annotationId('test-annotation-id');
  const testResourceUrl = `${testBaseUrl}/resources/${testResourceId}`;

  function setBusResponse(requestChannel: string, resultChannel: string, response: Record<string, unknown>) {
    (actorHarness as any).onEmit = (channel: string, payload: Record<string, unknown>) => {
      if (channel === requestChannel) {
        queueMicrotask(() => {
          actorHarness.events$.next({
            channel: resultChannel,
            payload: { correlationId: payload.correlationId, response },
          });
        });
      }
    };
  }

  beforeEach(() => {
    mockKy = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as any;

    vi.mocked(ky.create).mockReturnValue(mockKy);
    (actorHarness as any).onEmit = undefined;

    const transport = new HttpTransport({
      baseUrl: testBaseUrl,
      timeout: 10000,
    });
    client = new SemiontClient(transport, new HttpContentTransport(transport));
  });

  describe('Auth (HTTP)', () => {
    test('logout posts to /api/users/logout', async () => {
      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue({ message: 'ok' }),
      } as any);
      await client.logout();
      expect(mockKy.post).toHaveBeenCalledWith(`${testBaseUrl}/api/users/logout`, { headers: {} });
    });

    test('getMe gets /api/users/me', async () => {
      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue({ id: 'u1' }),
      } as any);
      await client.getMe();
      expect(mockKy.get).toHaveBeenCalledWith(`${testBaseUrl}/api/users/me`, { headers: {} });
    });

    test('authenticatePassword posts credentials', async () => {
      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue({ token: 'tok' }),
      } as any);
      await client.authenticatePassword('user@test.local' as any, 'pw');
      expect(mockKy.post).toHaveBeenCalledWith(
        `${testBaseUrl}/api/tokens/password`,
        expect.objectContaining({ json: { email: 'user@test.local', password: 'pw' } }),
      );
    });
  });

  describe('System Status (HTTP)', () => {
    test('getStatus gets /api/status', async () => {
      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue({ version: '1.0.0' }),
      } as any);
      const result = await client.getStatus();
      expect(result.version).toBe('1.0.0');
      expect(mockKy.get).toHaveBeenCalledWith(`${testBaseUrl}/api/status`, { headers: {} });
    });

    test('healthCheck gets /api/health', async () => {
      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue({ status: 'ok' }),
      } as any);
      await client.healthCheck();
      expect(mockKy.get).toHaveBeenCalledWith(`${testBaseUrl}/api/health`, { headers: {} });
    });
  });

  describe('Binary content (HTTP)', () => {
    test('getResourceRepresentation returns buffer + content type', async () => {
      const text = 'hello';
      const buffer = new TextEncoder().encode(text).buffer;
      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn((h: string) => h === 'content-type' ? 'text/plain' : null) },
        arrayBuffer: vi.fn().mockResolvedValue(buffer),
      } as any);

      const result = await client.getResourceRepresentation(testResourceId);
      expect(result.contentType).toBe('text/plain');
      expect(new TextDecoder().decode(result.data)).toBe(text);
    });

    test('getResourceRepresentation forwards accept header', async () => {
      const buffer = new TextEncoder().encode('md').buffer;
      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn(() => 'text/markdown') },
        arrayBuffer: vi.fn().mockResolvedValue(buffer),
      } as any);

      await client.getResourceRepresentation(testResourceId, { accept: 'text/markdown' });
      expect(mockKy.get).toHaveBeenCalledWith(
        testResourceUrl,
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: 'text/markdown' }),
        }),
      );
    });

    test('getResourceRepresentationStream returns readable stream', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(data); controller.close(); },
      });
      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn(() => 'video/mp4') },
        body: stream,
      } as any);

      const result = await client.getResourceRepresentationStream(testResourceId, { accept: 'video/mp4' as ContentFormat });
      expect(result.contentType).toBe('video/mp4');

      const reader = result.stream.getReader();
      const { value } = await reader.read();
      expect(value).toEqual(data);
    });

    test('getResourceRepresentationStream throws when body is null', async () => {
      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn(() => 'text/plain') },
        body: null,
      } as any);

      await expect(client.getResourceRepresentationStream(testResourceId))
        .rejects.toThrow('Response body is null');
    });
  });

  describe('yieldResource (HTTP multipart)', () => {
    // Pin the multipart wire shape that POST /resources expects. The
    // frontend compose page, the generation worker, and any future
    // server-side caller all funnel through this serializer; drift
    // here = 400s or silent field drops at the route boundary.

    // Helpers — extract a specific FormData field from the post call.
    const getPostedForm = (): FormData => {
      const call = vi.mocked(mockKy.post).mock.calls[0];
      expect(call).toBeDefined();
      const init = call![1] as { body: FormData };
      return init.body;
    };

    beforeEach(() => {
      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue({ resourceId: 'new-res-42' }),
      } as any);
    });

    test('POSTs to /resources (not /api/resources) with core fields', async () => {
      await client.yieldResource({
        name: 'My Doc',
        file: Buffer.from('hello'),
        format: 'text/plain',
        storageUri: 'file://docs/my-doc.txt',
      });

      expect(mockKy.post).toHaveBeenCalledTimes(1);
      const [url] = vi.mocked(mockKy.post).mock.calls[0]!;
      expect(url).toBe(`${testBaseUrl}/resources`);

      const form = getPostedForm();
      expect(form.get('name')).toBe('My Doc');
      expect(form.get('format')).toBe('text/plain');
      expect(form.get('storageUri')).toBe('file://docs/my-doc.txt');
      expect(form.get('file')).toBeInstanceOf(Blob);
    });

    test('serializes a Node Buffer as a Blob with the declared format', async () => {
      await client.yieldResource({
        name: 'Binary.png',
        file: Buffer.from([137, 80, 78, 71]),
        format: 'image/png',
        storageUri: 'file://img/Binary.png',
      });

      const form = getPostedForm();
      const blob = form.get('file') as Blob;
      expect(blob.type).toBe('image/png');
      expect(blob.size).toBe(4);
    });

    test('appends entityTypes as a JSON-stringified array', async () => {
      await client.yieldResource({
        name: 'Tagged',
        file: Buffer.from('x'),
        format: 'text/plain',
        storageUri: 'file://docs/tagged.txt',
        entityTypes: ['Person', 'Location'],
      });

      expect(getPostedForm().get('entityTypes')).toBe('["Person","Location"]');
    });

    test('omits entityTypes when empty (avoids posting an empty array)', async () => {
      await client.yieldResource({
        name: 'Plain',
        file: Buffer.from('x'),
        format: 'text/plain',
        storageUri: 'file://docs/plain.txt',
        entityTypes: [],
      });

      expect(getPostedForm().get('entityTypes')).toBeNull();
    });

    test('appends the full set of generation-provenance fields', async () => {
      const agent = {
        '@type': 'SoftwareAgent' as const,
        name: 'worker-pool / ollama gemma4:26b',
        worker: 'worker-pool',
        inferenceProvider: 'ollama',
        model: 'gemma4:26b',
      };

      await client.yieldResource({
        name: 'Generated Summary',
        file: Buffer.from('# Summary\n'),
        format: 'text/markdown',
        storageUri: 'file://generated/summary.md',
        creationMethod: 'generated',
        sourceResourceId: 'res-abc',
        sourceAnnotationId: 'ann-xyz',
        generationPrompt: 'Summarize the key points',
        generator: agent,
        isDraft: true,
        language: 'en',
      });

      const form = getPostedForm();
      expect(form.get('creationMethod')).toBe('generated');
      expect(form.get('sourceResourceId')).toBe('res-abc');
      expect(form.get('sourceAnnotationId')).toBe('ann-xyz');
      expect(form.get('generationPrompt')).toBe('Summarize the key points');
      // `generator` must be JSON-stringified — not `[object Object]`.
      const generatorRaw = form.get('generator');
      expect(typeof generatorRaw).toBe('string');
      expect(JSON.parse(generatorRaw as string)).toEqual(agent);
      expect(form.get('isDraft')).toBe('true');
      expect(form.get('language')).toBe('en');
    });

    test('sends Authorization header when auth option is provided', async () => {
      await client.yieldResource(
        {
          name: 'Auth Check',
          file: Buffer.from('x'),
          format: 'text/plain',
          storageUri: 'file://docs/auth-check.txt',
        },
        { auth: 'tok-123' as any },
      );

      const [, init] = vi.mocked(mockKy.post).mock.calls[0]!;
      expect((init as any).headers.Authorization).toBe('Bearer tok-123');
    });

    test('returns the resourceId from the server response', async () => {
      const result = await client.yieldResource({
        name: 'Round-trip',
        file: Buffer.from('x'),
        format: 'text/plain',
        storageUri: 'file://docs/round-trip.txt',
      });

      expect(result).toEqual({ resourceId: 'new-res-42' });
    });
  });

  // ── Bus request-response methods ──────────────────────────────────────

  describe('browseResource (bus)', () => {
    test('emits browse:resource-requested and returns result', async () => {
      setBusResponse('browse:resource-requested', 'browse:resource-result', {
        resource: { '@id': testResourceId, name: 'Test' },
      });

      const result = await client.browseResource(testResourceId);
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'browse:resource-requested',
        expect.objectContaining({ resourceId: testResourceId }),
      );
      expect((result as any).resource.name).toBe('Test');
    });
  });

  describe('browseResources (bus)', () => {
    test('emits browse:resources-requested with filters', async () => {
      setBusResponse('browse:resources-requested', 'browse:resources-result', { resources: [], total: 0 });

      await client.browseResources(10, false);
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'browse:resources-requested',
        expect.objectContaining({ limit: 10, archived: false }),
      );
    });
  });

  describe('getResourceEvents (bus)', () => {
    test('emits browse:events-requested and returns events', async () => {
      setBusResponse('browse:events-requested', 'browse:events-result', { events: [], total: 0 });

      const result = await client.getResourceEvents(testResourceId);
      expect((result as any).events).toEqual([]);
    });
  });

  describe('browseReferences (bus)', () => {
    test('emits browse:referenced-by-requested', async () => {
      setBusResponse('browse:referenced-by-requested', 'browse:referenced-by-result', { referencedBy: [] });

      await client.browseReferences(testResourceId);
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'browse:referenced-by-requested',
        expect.objectContaining({ resourceId: testResourceId }),
      );
    });
  });

  describe('browseAnnotation / browseAnnotations (bus)', () => {
    test('browseAnnotation emits browse:annotation-requested', async () => {
      setBusResponse('browse:annotation-requested', 'browse:annotation-result', { annotation: {} });
      await client.browseAnnotation(testResourceId, testAnnotationId);
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'browse:annotation-requested',
        expect.objectContaining({ resourceId: testResourceId, annotationId: testAnnotationId }),
      );
    });

    test('browseAnnotations emits browse:annotations-requested', async () => {
      setBusResponse('browse:annotations-requested', 'browse:annotations-result', { annotations: [] });
      await client.browseAnnotations(testResourceId);
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'browse:annotations-requested',
        expect.objectContaining({ resourceId: testResourceId }),
      );
    });
  });

  describe('getAnnotationHistory (bus)', () => {
    test('emits browse:annotation-history-requested', async () => {
      setBusResponse('browse:annotation-history-requested', 'browse:annotation-history-result', { events: [] });
      await client.getAnnotationHistory(testResourceId, testAnnotationId);
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'browse:annotation-history-requested',
        expect.objectContaining({ resourceId: testResourceId, annotationId: testAnnotationId }),
      );
    });
  });

  describe('listEntityTypes (bus)', () => {
    test('emits browse:entity-types-requested', async () => {
      setBusResponse('browse:entity-types-requested', 'browse:entity-types-result', { entityTypes: ['Person'] });
      const result = await client.listEntityTypes();
      expect((result as any).entityTypes).toEqual(['Person']);
    });
  });

  describe('browseFiles (bus)', () => {
    test('emits browse:directory-requested with path and sort', async () => {
      setBusResponse('browse:directory-requested', 'browse:directory-result', { files: [] });
      await client.browseFiles('docs', 'mtime');
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'browse:directory-requested',
        expect.objectContaining({ path: 'docs', sort: 'mtime' }),
      );
    });
  });

  describe('job commands (bus)', () => {
    test('getJobStatus emits job:status-requested', async () => {
      setBusResponse('job:status-requested', 'job:status-result', { status: 'running', jobId: 'j1' });
      await client.getJobStatus(jobId('j1'));
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'job:status-requested',
        expect.objectContaining({ jobId: 'j1' }),
      );
    });

    test('annotateReferences emits job:create with correct type', async () => {
      setBusResponse('job:create', 'job:created', { jobId: 'j1' });
      const result = await client.annotateReferences(testResourceId, { entityTypes: ['Person'] });
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'job:create',
        expect.objectContaining({
          jobType: 'reference-annotation',
          resourceId: testResourceId,
          params: { entityTypes: ['Person'] },
        }),
      );
      expect(result.jobId).toBe('j1');
    });

    test('annotateHighlights emits job:create', async () => {
      setBusResponse('job:create', 'job:created', { jobId: 'j1' });
      await client.annotateHighlights(testResourceId, { density: 5 });
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'job:create',
        expect.objectContaining({ jobType: 'highlight-annotation' }),
      );
    });

    test('annotateTags emits job:create', async () => {
      setBusResponse('job:create', 'job:created', { jobId: 'j1' });
      await client.annotateTags(testResourceId, { schemaId: 's1', categories: ['a'] });
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'job:create',
        expect.objectContaining({ jobType: 'tag-annotation' }),
      );
    });

    test('yieldResourceFromAnnotation emits job:create with generation type', async () => {
      setBusResponse('job:create', 'job:created', { jobId: 'j1' });
      await client.yieldResourceFromAnnotation(testResourceId, testAnnotationId, {
        title: 'T', storageUri: 'file://x', context: {},
      });
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
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
        token: 'tok', expiresAt: '2026-01-01',
      });
      const result = await client.generateCloneToken(testResourceId);
      expect((result as any).token).toBe('tok');
    });

    test('getResourceByToken emits yield:clone-resource-requested', async () => {
      setBusResponse('yield:clone-resource-requested', 'yield:clone-resource-result', {
        sourceResource: { name: 'src' },
      });
      const result = await client.getResourceByToken(cloneToken('tok-1'));
      expect((result as any).sourceResource.name).toBe('src');
    });

    test('createResourceFromToken emits yield:clone-create', async () => {
      setBusResponse('yield:clone-create', 'yield:clone-created', { resourceId: 'res-new' });
      const result = await client.createResourceFromToken({
        token: 'tok', name: 'new', content: 'c',
      });
      expect(result.resourceId).toBe('res-new');
    });
  });

  // ── Bus fire-and-forget methods ──────────────────────────────────────

  describe('fire-and-forget bus commands', () => {
    test('deleteAnnotation emits mark:delete', async () => {
      await client.deleteAnnotation(testResourceId, testAnnotationId);
      expect(actorHarness.emitSpy).toHaveBeenCalledWith('mark:delete', {
        annotationId: testAnnotationId,
        resourceId: testResourceId,
      });
    });

    test('addEntityType emits mark:add-entity-type', async () => {
      await client.addEntityType(entityType('Person'));
      expect(actorHarness.emitSpy).toHaveBeenCalledWith('mark:add-entity-type', { tag: 'Person' });
    });

    test('addEntityTypesBulk emits one event per tag', async () => {
      await client.addEntityTypesBulk([entityType('Person'), entityType('Place')]);
      expect(actorHarness.emitSpy).toHaveBeenCalledTimes(2);
      expect(actorHarness.emitSpy).toHaveBeenNthCalledWith(1, 'mark:add-entity-type', { tag: 'Person' });
      expect(actorHarness.emitSpy).toHaveBeenNthCalledWith(2, 'mark:add-entity-type', { tag: 'Place' });
    });

    test('bindAnnotation emits bind:update-body with correlationId', async () => {
      const result = await client.bindAnnotation(testResourceId, testAnnotationId, {
        operations: [{ op: 'add', item: { type: 'SpecificResource', source: 'r' } }],
      });
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'bind:update-body',
        expect.objectContaining({
          annotationId: testAnnotationId,
          resourceId: testResourceId,
          operations: expect.any(Array),
        }),
      );
      expect(result.correlationId).toMatch(/^[a-f0-9-]+$/);
    });

    test('beckonAttention emits beckon:focus', async () => {
      await client.beckonAttention('me', {
        annotationId: testAnnotationId as unknown as string,
        resourceId: testResourceId as unknown as string,
      });
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'beckon:focus',
        expect.objectContaining({ annotationId: testAnnotationId, resourceId: testResourceId }),
      );
    });

    test('gatherAnnotationContext emits gather:requested', async () => {
      await client.gatherAnnotationContext(testResourceId, testAnnotationId, {
        correlationId: 'c1', contextWindow: 500,
      });
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'gather:requested',
        expect.objectContaining({
          correlationId: 'c1',
          options: expect.objectContaining({ contextWindow: 500 }),
          annotationId: testAnnotationId,
          resourceId: testResourceId,
        }),
      );
    });

    test('matchSearch emits match:search-requested', async () => {
      await client.matchSearch(testResourceId, {
        correlationId: 'c1', referenceId: 'ref-1', context: {},
      });
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'match:search-requested',
        expect.objectContaining({
          correlationId: 'c1', referenceId: 'ref-1', resourceId: testResourceId,
        }),
      );
    });
  });

  describe('annotation creation (bus)', () => {
    test('markAnnotation emits mark:create-request and returns annotationId', async () => {
      setBusResponse('mark:create-request', 'mark:create-ok', { annotationId: 'ann-new' });
      const result = await client.markAnnotation(testResourceId, {
        motivation: 'highlighting', target: { source: testResourceId },
      } as any);
      expect(result.annotationId).toBe('ann-new');
      expect(actorHarness.emitSpy).toHaveBeenCalledWith(
        'mark:create-request',
        expect.objectContaining({ resourceId: testResourceId }),
      );
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────

  describe('token$', () => {
    test('namespaces and actor read the current token from the observable', async () => {
      const { BehaviorSubject } = await import('rxjs');
      const token$ = new BehaviorSubject<any>('tok-1');
      const transport = new HttpTransport({ baseUrl: testBaseUrl, token$ });
      const c = new SemiontClient(transport, new HttpContentTransport(transport));
      expect(c).toBeDefined();
      token$.next('tok-2');
      // No error — the observable is the source of truth; updates just propagate.
    });

    test('defaults to null BehaviorSubject when token$ is omitted', () => {
      const transport = new HttpTransport({ baseUrl: testBaseUrl });
      const c = new SemiontClient(transport, new HttpContentTransport(transport));
      expect(c).toBeDefined();
    });
  });

  describe('subscribeToResource', () => {
    test('adds scoped channels and returns a cleanup function', () => {
      const cleanup = client.subscribeToResource(testResourceId);
      expect(actorHarness.addChannels).toHaveBeenCalledWith(
        expect.any(Array),
        testResourceId as unknown as string,
      );
      expect(typeof cleanup).toBe('function');
      cleanup();
      expect(actorHarness.removeChannels).toHaveBeenCalled();
    });

    test('same-resource re-entry is ref-counted (no extra addChannels, no teardown until last unsubscribe)', () => {
      const addBefore = actorHarness.addChannels.mock.calls.length;
      const removeBefore = actorHarness.removeChannels.mock.calls.length;

      const first = client.subscribeToResource(testResourceId);
      const second = client.subscribeToResource(testResourceId);
      expect(actorHarness.addChannels.mock.calls.length - addBefore).toBe(1);

      first();
      expect(actorHarness.removeChannels.mock.calls.length - removeBefore).toBe(0);

      second();
      expect(actorHarness.removeChannels.mock.calls.length - removeBefore).toBe(1);
    });

    test('calling an unsubscribe twice is a no-op (idempotent)', () => {
      const removeBefore = actorHarness.removeChannels.mock.calls.length;
      const cleanup = client.subscribeToResource(testResourceId);
      cleanup();
      cleanup();
      expect(actorHarness.removeChannels.mock.calls.length - removeBefore).toBe(1);
    });

    test('different-resource re-entry throws', () => {
      client.subscribeToResource(testResourceId);
      const otherResourceId = 'other-resource' as typeof testResourceId;
      expect(() => client.subscribeToResource(otherResourceId)).toThrow(
        /already subscribed to resource/,
      );
    });
  });

  // ── Integration: global correlation-ID responses don't require subscribeToResource ──

  describe('results without subscribeToResource (SIMPLE-BUS gap #1 closed)', () => {
    test('client.match.search() resolves from a global match:search-results event without calling subscribeToResource', async () => {
      const { firstValueFrom } = await import('rxjs');
      const gatheredContext = { sourceContext: {}, targetContext: {} } as any;

      // NOTE: no subscribeToResource call. If the Phase 1 reclassification
      // and the BUS_RESULT_CHANNELS → local-bus bridge are both correct,
      // the Observable resolves purely from a globally-delivered result.

      const searchP = firstValueFrom(
        client.match.search(testResourceId, 'ref-1', gatheredContext, { limit: 5 }),
      );

      await new Promise((r) => setTimeout(r, 10));
      const emitted = actorHarness.emitSpy.mock.calls.find(
        (call) => call[0] === 'match:search-requested',
      );
      expect(emitted).toBeTruthy();
      const cid = emitted![1].correlationId as string;

      actorHarness.events$.next({
        channel: 'match:search-results',
        payload: { correlationId: cid, referenceId: 'ref-1', response: [] },
      });

      const result = await searchP;
      expect((result as any).correlationId).toBe(cid);
    });

    test('client.gather.annotation() resolves from a global gather:complete event without calling subscribeToResource', async () => {
      const { lastValueFrom } = await import('rxjs');

      const gatherP = lastValueFrom(
        client.gather.annotation(testAnnotationId, testResourceId, { contextWindow: 500 }),
      );

      await new Promise((r) => setTimeout(r, 10));
      const emitted = actorHarness.emitSpy.mock.calls.find(
        (call) => call[0] === 'gather:requested',
      );
      expect(emitted).toBeTruthy();
      const cid = emitted![1].correlationId as string;

      actorHarness.events$.next({
        channel: 'gather:complete',
        payload: {
          correlationId: cid,
          annotationId: testAnnotationId,
          response: { sourceContext: {} },
        },
      });

      const result = await gatherP;
      expect((result as any).correlationId).toBe(cid);
    });

    test('a failed match:search-failed event resolves the Observable with an error', async () => {
      const { firstValueFrom } = await import('rxjs');
      const gatheredContext = { sourceContext: {}, targetContext: {} } as any;

      const searchP = firstValueFrom(
        client.match.search(testResourceId, 'ref-x', gatheredContext),
      );

      await new Promise((r) => setTimeout(r, 10));
      const cid = actorHarness.emitSpy.mock.calls.find(
        (call) => call[0] === 'match:search-requested',
      )![1].correlationId as string;

      actorHarness.events$.next({
        channel: 'match:search-failed',
        payload: { correlationId: cid, referenceId: 'ref-x', error: 'inference provider down' },
      });

      await expect(searchP).rejects.toThrow(/inference provider down/);
    });
  });

  describe('dispose', () => {
    test('disposes actor and cleans up subscriptions', () => {
      client.subscribeToResource(testResourceId);
      client.dispose();
      expect(actorHarness.dispose).toHaveBeenCalled();
    });

    test('is safe to call without active actor', () => {
      const transport = new HttpTransport({ baseUrl: testBaseUrl });
      const freshClient = new SemiontClient(transport, new HttpContentTransport(transport));
      expect(() => freshClient.dispose()).not.toThrow();
    });
  });
});
