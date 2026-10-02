/**
 * The upload path a browser page takes: `HttpContentTransport.putBinary`
 * through `XMLHttpRequest`, when its caller asks for progress or gives a
 * `signal`. Where there is no `XMLHttpRequest` the upload goes through ky,
 * and `http-content-transport.upload.test.ts` holds that against a real
 * server; `http-transport.http-paths.test.ts` holds the form's shape.
 *
 * We stub `globalThis.XMLHttpRequest` with a fake that exposes the same
 * event surface (`upload.onprogress`, `onload`, `onerror`) and lets each
 * test drive the lifecycle deterministically.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { baseUrl, resourceId } from '@semiont/core';
import type { KyInstance } from 'ky';

vi.mock('ky', () => ({
  default: { create: vi.fn() },
}));

import ky from 'ky';
import { HttpTransport } from '../http-transport';
import { APIError } from '../api-error';
import { HttpContentTransport } from '../http-content-transport';
import { BehaviorSubject } from 'rxjs';

// The transport is constructed with a live token, so its bus actor
// auto-starts and would otherwise issue a REAL /bus/subscribe fetch from
// inside this jsdom environment (whose undici body path lacks `Buffer`,
// yielding unhandled rejections). This suite is about the XHR upload path
// only — park the SSE fetch on a never-resolving promise.
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

class FakeXHR {
  static instances: FakeXHR[] = [];

  // Public surface mirroring the parts the upload path uses.
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  status = 0;
  statusText = '';
  responseText = '';
  /** A real XMLHttpRequest answers for any header; this fake's responses carry none. */
  getResponseHeader(_name: string): string | null {
    return null;
  }

  // Captured by the fake so tests can assert on them.
  openCalls: Array<{ method: string; url: string }> = [];
  setRequestHeaderCalls: Array<{ name: string; value: string }> = [];
  sendCalls: unknown[] = [];
  abortCalled = 0;

  constructor() {
    FakeXHR.instances.push(this);
  }

  open(method: string, url: string): void {
    this.openCalls.push({ method, url });
  }
  setRequestHeader(name: string, value: string): void {
    this.setRequestHeaderCalls.push({ name, value });
  }
  send(body: unknown): void {
    this.sendCalls.push(body);
  }
  abort(): void {
    this.abortCalled++;
  }

  // Test helpers — fire the lifecycle events explicitly.
  fireProgress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }
  fireSuccess(status: number, body: unknown): void {
    this.status = status;
    this.statusText = 'OK';
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  fireFailure(status: number, statusText: string, body: unknown): void {
    this.status = status;
    this.statusText = statusText;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
  fireNetworkError(): void {
    this.onerror?.();
  }
}

const testBaseUrl = baseUrl('http://test.example.com');

function makeTransportAndContent() {
  const mockKy: Partial<KyInstance> = {
    post: vi.fn(),
    get: vi.fn(),
    extend: vi.fn(() => mockKy as KyInstance),
  };
  vi.mocked(ky.create).mockReturnValue(mockKy as KyInstance);

  const token$ = new BehaviorSubject<string | null>('test-token-abc');
  const transport = new HttpTransport({
    baseUrl: testBaseUrl,
    token$: token$ as never,
  });
  const content = new HttpContentTransport(transport);
  return { transport, content, mockKy, token$ };
}

describe('HttpContentTransport.putBinary — XHR path', () => {
  let originalXHR: typeof globalThis.XMLHttpRequest;

  beforeEach(() => {
    originalXHR = globalThis.XMLHttpRequest;
    FakeXHR.instances = [];
    (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest = FakeXHR;
  });

  afterEach(() => {
    globalThis.XMLHttpRequest = originalXHR;
    vi.clearAllMocks();
  });

  test('sends the cited job as a form field, beside the other provenance fields', async () => {
    // buildFormData appends a fixed list of fields, so a new one is dropped
    // silently unless it is named here. `jobId` is how a worker's create
    // reaches the gateway route that forwards it onto yield:create.
    const { content } = makeTransportAndContent();

    const promise = content.putBinary(
      {
        name: 'gen.md',
        file: Buffer.from('generated'),
        format: 'text/markdown',
        storageUri: 'file://gen.md',
        sourceResourceId: 'res-source',
        jobId: 'job-42',
      },
      { onProgress: vi.fn() },
    );

    const sent = FakeXHR.instances[0]!.sendCalls[0] as FormData;
    expect(sent.get('jobId')).toBe('job-42');
    expect(sent.get('sourceResourceId')).toBe('res-source');

    FakeXHR.instances[0]!.fireSuccess(201, { resourceId: 'new-res-2' });
    await expect(promise).resolves.toEqual({ resourceId: 'new-res-2' });
  });

  test('opts into XHR path when `onProgress` is provided', async () => {
    const { content } = makeTransportAndContent();
    const onProgress = vi.fn();

    const promise = content.putBinary(
      {
        name: 'doc.md',
        file: Buffer.from('hello world'),
        format: 'text/markdown',
        storageUri: 'file://docs/doc.md',
      },
      { onProgress },
    );

    expect(FakeXHR.instances).toHaveLength(1);
    const xhr = FakeXHR.instances[0]!;
    expect(xhr.openCalls).toEqual([{ method: 'POST', url: `${testBaseUrl}/resources` }]);
    expect(xhr.sendCalls).toHaveLength(1);

    xhr.fireSuccess(201, { resourceId: 'new-res-1' });
    await expect(promise).resolves.toEqual({ resourceId: 'new-res-1' });
  });

  test('emits onProgress events from xhr.upload.onprogress', async () => {
    const { content } = makeTransportAndContent();
    const onProgress = vi.fn();

    const promise = content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { onProgress },
    );

    const xhr = FakeXHR.instances[0]!;
    xhr.fireProgress(1024, 4096);
    xhr.fireProgress(2048, 4096);
    xhr.fireProgress(4096, 4096);

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls[0]?.[0]).toEqual({ bytesUploaded: 1024, totalBytes: 4096 });
    expect(onProgress.mock.calls[1]?.[0]).toEqual({ bytesUploaded: 2048, totalBytes: 4096 });
    expect(onProgress.mock.calls[2]?.[0]).toEqual({ bytesUploaded: 4096, totalBytes: 4096 });

    xhr.fireSuccess(201, { resourceId: 'r' });
    await promise;
  });

  test('reports totalBytes=0 when lengthComputable is false', async () => {
    const { content } = makeTransportAndContent();
    const onProgress = vi.fn();

    const promise = content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { onProgress },
    );

    FakeXHR.instances[0]!.fireProgress(512, 0, false);
    expect(onProgress.mock.calls[0]?.[0]).toEqual({ bytesUploaded: 512, totalBytes: 0 });

    FakeXHR.instances[0]!.fireSuccess(201, { resourceId: 'r' });
    await promise;
  });

  test('sets Authorization and (when active) traceparent headers on the XHR', async () => {
    const { content } = makeTransportAndContent();

    const promise = content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { onProgress: vi.fn() },
    );

    const xhr = FakeXHR.instances[0]!;
    const authHeader = xhr.setRequestHeaderCalls.find((h) => h.name === 'Authorization');
    expect(authHeader).toEqual({ name: 'Authorization', value: 'Bearer test-token-abc' });

    xhr.fireSuccess(201, { resourceId: 'r' });
    await promise;
  });

  test('rejects with APIError on 4xx and routes the error to transport.errors$', async () => {
    const { content, transport } = makeTransportAndContent();
    const onProgress = vi.fn();

    const errors: unknown[] = [];
    transport.errors$.subscribe((e) => errors.push(e));

    const promise = content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { onProgress },
    );

    FakeXHR.instances[0]!.fireFailure(403, 'Forbidden', { error: 'no permission' });

    await expect(promise).rejects.toBeInstanceOf(APIError);
    await promise.catch((err) => {
      expect(err.status).toBe(403);
      expect(err.code).toBe('forbidden');
      expect(err.message).toBe('no permission');
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(APIError);
  });

  test('rejects with APIError on 5xx with classify code "unavailable"', async () => {
    const { content } = makeTransportAndContent();

    const promise = content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { onProgress: vi.fn() },
    );

    FakeXHR.instances[0]!.fireFailure(503, 'Service Unavailable', { error: 'down' });

    const err = (await promise.catch((e) => e)) as APIError;
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('unavailable');
  });

  test('rejects with APIError on network failure, classified "unavailable"', async () => {
    const { content, transport } = makeTransportAndContent();

    const errors: unknown[] = [];
    transport.errors$.subscribe((e) => errors.push(e));

    const promise = content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { onProgress: vi.fn() },
    );

    FakeXHR.instances[0]!.fireNetworkError();

    const err = (await promise.catch((e) => e)) as APIError;
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(0);
    expect(err.statusText).toBe('network-error');
    expect(err.code).toBe('unavailable');
    expect(errors).toEqual([err]);
  });

  test('aborts the in-flight XHR when the AbortSignal fires', async () => {
    const { content, transport } = makeTransportAndContent();
    const controller = new AbortController();

    const errors: unknown[] = [];
    transport.errors$.subscribe((e) => errors.push(e));

    const promise = content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { onProgress: vi.fn(), signal: controller.signal },
    );

    const xhr = FakeXHR.instances[0]!;
    expect(xhr.abortCalled).toBe(0);

    controller.abort();

    expect(xhr.abortCalled).toBe(1);
    // Cancelled, it rejects with its caller's reason, as an abandoned bus
    // request does, and as the upload does where there is no XMLHttpRequest.
    expect(await promise.catch((e: unknown) => e)).toBe(controller.signal.reason);
    // A cancel the caller asked for is theirs alone, not a transport error.
    expect(errors).toEqual([]);
  });

  test('rejects immediately if signal is already aborted at call time', async () => {
    const { content, transport } = makeTransportAndContent();
    const controller = new AbortController();
    controller.abort();

    const errors: unknown[] = [];
    transport.errors$.subscribe((e) => errors.push(e));

    const promise = content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { signal: controller.signal },
    );

    // No XHR should have been opened.
    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0]!.sendCalls).toHaveLength(0);

    expect(await promise.catch((e: unknown) => e)).toBe(controller.signal.reason);
    expect(errors).toEqual([]);
  });

  test('falls through to ky path when neither onProgress nor signal is set', async () => {
    const { content, mockKy } = makeTransportAndContent();
    vi.mocked(mockKy.post!).mockReturnValue({
      json: vi.fn().mockResolvedValue({ resourceId: 'ky-path-result' }),
    } as never);

    const result = await content.putBinary({
      name: 'a',
      file: Buffer.from('xx'),
      format: 'text/plain',
      storageUri: 'file://a',
    });

    expect(FakeXHR.instances).toHaveLength(0);
    expect(mockKy.post).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ resourceId: resourceId('ky-path-result') });
  });
});

/**
 * Where there is no `XMLHttpRequest` (Node: a worker, the CLI, a script) the
 * upload must not reach for one. Every `yield.resource(...)` passes a
 * `signal` and an `onProgress`, and an upload that took the XHR path on
 * their account threw `XMLHttpRequest is not defined` and killed every
 * generation job. It goes through ky, and ky is given what the caller asked
 * for: the signal, and a body it can take a piece at a time.
 *
 * This block lives outside the one that stubs `XMLHttpRequest`, so the stub
 * is never installed here.
 */
describe('HttpContentTransport.putBinary — where there is no XMLHttpRequest', () => {
  let savedXHR: typeof globalThis.XMLHttpRequest | undefined;

  beforeEach(() => {
    // An earlier test's stub may still be installed.
    savedXHR = globalThis.XMLHttpRequest;
    delete (globalThis as unknown as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  });

  afterEach(() => {
    if (savedXHR !== undefined) {
      (globalThis as unknown as { XMLHttpRequest: typeof globalThis.XMLHttpRequest }).XMLHttpRequest = savedXHR;
    }
    vi.clearAllMocks();
  });

  const posted = (mockKy: Partial<KyInstance>) =>
    vi.mocked(mockKy.post!).mock.calls[0]![1] as { body: unknown; signal?: AbortSignal; timeout?: unknown; headers: Record<string, string> };

  test('given only a `signal`, it goes through ky with that signal and the form as its body', async () => {
    const { content, mockKy } = makeTransportAndContent();
    vi.mocked(mockKy.post!).mockReturnValue({
      json: vi.fn().mockResolvedValue({ resourceId: 'node-ky-result' }),
    } as never);

    const controller = new AbortController();
    const result = await content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { signal: controller.signal },
    );

    expect(mockKy.post).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ resourceId: resourceId('node-ky-result') });
    expect(posted(mockKy).signal).toBe(controller.signal);
    expect(posted(mockKy).body).toBeInstanceOf(FormData);
  });

  test('given `onProgress` and a `signal`, as `yield.resource` gives them, it goes through ky with a body sent in pieces', async () => {
    const { content, mockKy } = makeTransportAndContent();
    vi.mocked(mockKy.post!).mockReturnValue({
      json: vi.fn().mockResolvedValue({ resourceId: 'node-ky-result-2' }),
    } as never);

    const onProgress = vi.fn();
    const controller = new AbortController();
    const result = await content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { onProgress, signal: controller.signal },
    );

    expect(mockKy.post).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ resourceId: resourceId('node-ky-result-2') });
    const { body, signal, headers } = posted(mockKy);
    expect(signal).toBe(controller.signal);
    expect(body).toBeInstanceOf(ReadableStream);
    expect(headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);

    // This ky sent nothing, so nothing has been reported: a piece is
    // reported when it is asked for, never ahead of that.
    expect(onProgress).not.toHaveBeenCalled();
    await (body as ReadableStream<Uint8Array>).getReader().read();
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  test('an upload is given no deadline, whatever its caller asked for', async () => {
    const { content, mockKy } = makeTransportAndContent();
    vi.mocked(mockKy.post!).mockReturnValue({
      json: vi.fn().mockResolvedValue({ resourceId: 'r' }),
    } as never);

    await content.putBinary({ name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' });

    expect(posted(mockKy).timeout).toBe(false);
  });
});

/**
 * Regression guard for the browser-upload bug surfaced at /know/compose:
 * `buildFormData()` referenced the Node global `Buffer` directly via
 * `Buffer.isBuffer(...)`, which throws `ReferenceError: Buffer is not
 * defined` synchronously in browsers (Buffer is not a browser global).
 *
 * The fix gates the Buffer branch on a runtime check
 * (`typeof Buffer !== 'undefined'`); these tests pin that behavior by
 * deleting `globalThis.Buffer` and verifying putBinary still works for
 * `File` inputs (the only shape browsers ever send).
 */
describe('HttpContentTransport.putBinary — runtime fallback when Buffer is unavailable', () => {
  let savedBuffer: typeof globalThis.Buffer | undefined;

  beforeEach(() => {
    savedBuffer = globalThis.Buffer;
    delete (globalThis as unknown as { Buffer?: unknown }).Buffer;
  });

  afterEach(() => {
    if (savedBuffer !== undefined) {
      (globalThis as unknown as { Buffer: typeof globalThis.Buffer }).Buffer = savedBuffer;
    }
    vi.clearAllMocks();
  });

  test('putBinary with a File works when Buffer is undefined (browser case)', async () => {
    const { content, mockKy } = makeTransportAndContent();
    vi.mocked(mockKy.post!).mockReturnValue({
      json: vi.fn().mockResolvedValue({ resourceId: 'browser-result' }),
    } as never);

    // Construct a real File. Browser uploads always hit this branch in
    // buildFormData; the Buffer branch (which referenced the bare global)
    // is only for Node-side workers and must be skipped without throwing.
    const file = new File(['hello'], 'doc.md', { type: 'text/markdown' });

    // Pre-fix this would throw `Buffer is not defined` synchronously
    // because buildFormData() did `Buffer.isBuffer(...)` unguarded.
    const result = await content.putBinary({
      name: 'doc.md',
      file,
      format: 'text/markdown',
      storageUri: 'file://docs/doc.md',
    });

    expect(result).toEqual({ resourceId: resourceId('browser-result') });
    expect(mockKy.post).toHaveBeenCalledTimes(1);
  });

  test('putBinary with a non-File, non-Buffer input throws the documented error (not ReferenceError)', async () => {
    const { content } = makeTransportAndContent();

    // Pre-fix this would throw `Buffer is not defined` (a ReferenceError
    // from the bare global). With the typeof guard, both branches fall
    // through to the explicit `throw new Error('file must be a File or
    // Buffer')` — the documented, intentional failure.
    await expect(
      content.putBinary({
        name: 'a',
        file: 'not a file' as unknown as File,
        format: 'text/plain',
        storageUri: 'file://a',
      }),
    ).rejects.toThrow(/file must be a File or Buffer/);
  });
});
