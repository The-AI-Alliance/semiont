/**
 * HttpTransport / HttpContentTransport — HTTP wire-shape tests.
 *
 * Pins the URL paths, methods, headers, and multipart shape that the
 * backend's routes expect. Mocks `ky` at the module boundary; no
 * SemiontClient involvement.
 *
 * Migrated from the pre-SDK-split `client.test.ts` (api-client side):
 *   - Auth / status / health endpoints
 *   - Binary content (`HttpContentTransport.getBinary` + stream)
 *   - Multipart upload (`HttpContentTransport.putBinary`)
 *   - `HttpTransport.subscribeToResource` ref-counting (mocks the
 *     local `actor-vm` module to assert add/removeChannels)
 *   - `token$` lifecycle
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { KyInstance } from 'ky';
import { baseUrl, resourceId } from '@semiont/core';

vi.mock('ky', () => ({
  default: {
    create: vi.fn(),
  },
}));

// Mock the local actor-vm so subscribeToResource ref-counting can be
// asserted via spies without spinning up a real SSE connection.
const actorHarness = {
  addChannels: vi.fn(),
  removeChannels: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('../actor-vm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../actor-vm')>();
  const { BehaviorSubject, Subject } = await import('rxjs');
  const { filter, map } = await import('rxjs/operators');
  return {
    ...actual,
    createActorVM: () => {
      const events$ = new Subject<{ channel: string; payload: Record<string, unknown> }>();
      return {
        on$: <T,>(channel: string) =>
          events$.pipe(filter((e) => e.channel === channel), map((e) => e.payload as T)),
        emit: vi.fn(),
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
import { HttpTransport } from '../http-transport';
import { HttpContentTransport } from '../http-content-transport';

const testBaseUrl = baseUrl('http://localhost:4000');
const testResourceId = resourceId('test-resource-id');
const testResourceUrl = `${testBaseUrl}/resources/${testResourceId}`;

describe('HttpTransport — HTTP wire shape', () => {
  let transport: HttpTransport;
  let content: HttpContentTransport;
  let mockKy: KyInstance;

  beforeEach(() => {
    mockKy = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as KyInstance;
    vi.mocked(ky.create).mockReturnValue(mockKy);
    actorHarness.addChannels.mockClear();
    actorHarness.removeChannels.mockClear();
    actorHarness.dispose.mockClear();
    transport = new HttpTransport({ baseUrl: testBaseUrl, timeout: 10000 });
    content = new HttpContentTransport(transport);
  });

  describe('Auth', () => {
    test('logout posts to /api/users/logout', async () => {
      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue({ message: 'ok' }),
      } as never);
      await transport.logout();
      expect(mockKy.post).toHaveBeenCalledWith(`${testBaseUrl}/api/users/logout`, { headers: {} });
    });

    test('getCurrentUser gets /api/users/me', async () => {
      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue({ id: 'u1' }),
      } as never);
      await transport.getCurrentUser();
      expect(mockKy.get).toHaveBeenCalledWith(`${testBaseUrl}/api/users/me`, { headers: {} });
    });

    test('authenticatePassword posts credentials to /api/tokens/password', async () => {
      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue({ token: 'tok' }),
      } as never);
      await transport.authenticatePassword('user@test.local' as never, 'pw');
      expect(mockKy.post).toHaveBeenCalledWith(
        `${testBaseUrl}/api/tokens/password`,
        expect.objectContaining({ json: { email: 'user@test.local', password: 'pw' } }),
      );
    });
  });

  describe('System status', () => {
    test('getStatus gets /api/status', async () => {
      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue({ version: '1.0.0' }),
      } as never);
      const result = await transport.getStatus();
      expect((result as { version: string }).version).toBe('1.0.0');
      expect(mockKy.get).toHaveBeenCalledWith(`${testBaseUrl}/api/status`, { headers: {} });
    });

    test('healthCheck gets /api/health', async () => {
      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue({ status: 'ok' }),
      } as never);
      await transport.healthCheck();
      expect(mockKy.get).toHaveBeenCalledWith(`${testBaseUrl}/api/health`, { headers: {} });
    });
  });

  describe('Binary content (HttpContentTransport.getBinary)', () => {
    test('returns buffer + content type', async () => {
      const text = 'hello';
      const buffer = new TextEncoder().encode(text).buffer;
      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn((h: string) => (h === 'content-type' ? 'text/plain' : null)) },
        arrayBuffer: vi.fn().mockResolvedValue(buffer),
      } as never);

      const result = await content.getBinary(testResourceId);
      expect(result.contentType).toBe('text/plain');
      expect(new TextDecoder().decode(result.data)).toBe(text);
    });

    test('forwards accept header', async () => {
      const buffer = new TextEncoder().encode('md').buffer;
      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn(() => 'text/markdown') },
        arrayBuffer: vi.fn().mockResolvedValue(buffer),
      } as never);

      await content.getBinary(testResourceId, { accept: 'text/markdown' });
      expect(mockKy.get).toHaveBeenCalledWith(
        testResourceUrl,
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: 'text/markdown' }),
        }),
      );
    });

    test('getBinaryStream returns readable stream', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn(() => 'video/mp4') },
        body: stream,
      } as never);

      const result = await content.getBinaryStream(testResourceId, { accept: 'video/mp4' });
      expect(result.contentType).toBe('video/mp4');
      const reader = result.stream.getReader();
      const { value } = await reader.read();
      expect(value).toEqual(data);
    });

    test('getBinaryStream throws when body is null', async () => {
      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn(() => 'text/plain') },
        body: null,
      } as never);
      await expect(content.getBinaryStream(testResourceId)).rejects.toThrow('Response body is null');
    });
  });

  describe('Multipart upload (HttpContentTransport.putBinary)', () => {
    // Pin the multipart wire shape that POST /resources expects. The
    // frontend compose page, the generation worker, and any future
    // server-side caller all funnel through this serializer; drift
    // here = 400s or silent field drops at the route boundary.

    const getPostedForm = (): FormData => {
      const call = vi.mocked(mockKy.post).mock.calls[0];
      expect(call).toBeDefined();
      const init = call![1] as { body: FormData };
      return init.body;
    };

    beforeEach(() => {
      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue({ resourceId: 'new-res-42' }),
      } as never);
    });

    test('POSTs to /resources (not /api/resources) with core fields', async () => {
      await content.putBinary({
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
      await content.putBinary({
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
      await content.putBinary({
        name: 'Tagged',
        file: Buffer.from('x'),
        format: 'text/plain',
        storageUri: 'file://docs/tagged.txt',
        entityTypes: ['Person', 'Location'],
      });
      expect(getPostedForm().get('entityTypes')).toBe('["Person","Location"]');
    });

    test('omits entityTypes when empty (avoids posting an empty array)', async () => {
      await content.putBinary({
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

      await content.putBinary({
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
      const generatorRaw = form.get('generator');
      expect(typeof generatorRaw).toBe('string');
      expect(JSON.parse(generatorRaw as string)).toEqual(agent);
      expect(form.get('isDraft')).toBe('true');
      expect(form.get('language')).toBe('en');
    });

    test('sends Authorization header when auth option is provided', async () => {
      await content.putBinary(
        {
          name: 'Auth Check',
          file: Buffer.from('x'),
          format: 'text/plain',
          storageUri: 'file://docs/auth-check.txt',
        },
        { auth: 'tok-123' as never },
      );

      const [, init] = vi.mocked(mockKy.post).mock.calls[0]!;
      expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok-123');
    });

    test('returns the resourceId from the server response', async () => {
      const result = await content.putBinary({
        name: 'Round-trip',
        file: Buffer.from('x'),
        format: 'text/plain',
        storageUri: 'file://docs/round-trip.txt',
      });
      expect(result).toEqual({ resourceId: 'new-res-42' });
    });
  });

  describe('subscribeToResource', () => {
    test('adds scoped channels and returns a cleanup function', () => {
      const cleanup = transport.subscribeToResource(testResourceId);
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

      const first = transport.subscribeToResource(testResourceId);
      const second = transport.subscribeToResource(testResourceId);
      expect(actorHarness.addChannels.mock.calls.length - addBefore).toBe(1);

      first();
      expect(actorHarness.removeChannels.mock.calls.length - removeBefore).toBe(0);

      second();
      expect(actorHarness.removeChannels.mock.calls.length - removeBefore).toBe(1);
    });

    test('calling an unsubscribe twice is a no-op (idempotent)', () => {
      const removeBefore = actorHarness.removeChannels.mock.calls.length;
      const cleanup = transport.subscribeToResource(testResourceId);
      cleanup();
      cleanup();
      expect(actorHarness.removeChannels.mock.calls.length - removeBefore).toBe(1);
    });

    test('different-resource re-entry throws', () => {
      transport.subscribeToResource(testResourceId);
      const otherResourceId = resourceId('other-resource');
      expect(() => transport.subscribeToResource(otherResourceId)).toThrow(/already subscribed to resource/);
    });
  });

  describe('token$', () => {
    test('accepts a BehaviorSubject token source and constructs without error', async () => {
      const { BehaviorSubject } = await import('rxjs');
      const token$ = new BehaviorSubject<string | null>('tok-1');
      const t = new HttpTransport({ baseUrl: testBaseUrl, token$: token$ as never });
      expect(t).toBeDefined();
      // Updates propagate; no throw.
      token$.next('tok-2');
    });

    test('defaults to a null BehaviorSubject when token$ is omitted', () => {
      const t = new HttpTransport({ baseUrl: testBaseUrl });
      expect(t).toBeDefined();
    });
  });
});
