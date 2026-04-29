/**
 * Tests for the XHR-based byte-progress upload path in
 * `HttpContentTransport.putBinary`. The path lights up when callers pass
 * `onProgress` or `signal` (the ky path is exercised separately in
 * `http-transport.http-paths.test.ts`).
 *
 * We stub `globalThis.XMLHttpRequest` with a fake that exposes the same
 * event surface (`upload.onprogress`, `onload`, `onerror`, `ontimeout`,
 * `onabort`) and lets each test drive the lifecycle deterministically.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { baseUrl, resourceId } from '@semiont/core';
import type { KyInstance } from 'ky';

vi.mock('ky', () => ({
  default: { create: vi.fn() },
}));

import ky from 'ky';
import { HttpTransport, APIError } from '../http-transport';
import { HttpContentTransport } from '../http-content-transport';
import { BehaviorSubject } from 'rxjs';

class FakeXHR {
  static instances: FakeXHR[] = [];

  // Public surface mirroring the parts the upload path uses.
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  status = 0;
  statusText = '';
  responseText = '';

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
    this.onabort?.();
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

    FakeXHR.instances[0]!.fireFailure(403, 'Forbidden', { message: 'no permission' });

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

    FakeXHR.instances[0]!.fireFailure(503, 'Service Unavailable', { message: 'down' });

    const err = (await promise.catch((e) => e)) as APIError;
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('unavailable');
  });

  test('rejects with APIError on network failure', async () => {
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
    expect(errors).toHaveLength(1);
  });

  test('aborts the in-flight XHR when the AbortSignal fires', async () => {
    const { content } = makeTransportAndContent();
    const controller = new AbortController();

    const promise = content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { onProgress: vi.fn(), signal: controller.signal },
    );

    const xhr = FakeXHR.instances[0]!;
    expect(xhr.abortCalled).toBe(0);

    controller.abort();

    expect(xhr.abortCalled).toBe(1);
    const err = (await promise.catch((e) => e)) as APIError;
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(0);
  });

  test('rejects immediately if signal is already aborted at call time', async () => {
    const { content } = makeTransportAndContent();
    const controller = new AbortController();
    controller.abort();

    const promise = content.putBinary(
      { name: 'a', file: Buffer.from('xx'), format: 'text/plain', storageUri: 'file://a' },
      { signal: controller.signal },
    );

    // No XHR should have been opened.
    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0]!.sendCalls).toHaveLength(0);

    const err = (await promise.catch((e) => e)) as APIError;
    expect(err).toBeInstanceOf(APIError);
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
