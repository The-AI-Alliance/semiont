/**
 * What a stopped retry looks like TO THE CALLER (RETRY-CLASSIFICATION P3).
 *
 * The sibling hooks suite invokes `beforeRetry` directly against a mocked
 * `ky`, which pins the classification but says nothing about what a caller
 * awaiting `.json()` actually receives. That is the contract this phase must
 * not change, so these tests use **real ky** with `fetch` stubbed and drive
 * the transport's public methods end to end.
 *
 * It matters because the two ways to stop a retry are not interchangeable:
 * `ky.stop` resolves the caller's promise with `undefined`, after which the
 * `.json()` shortcut dereferences it (`Ky.js:127`, then `response.text()`);
 * rethrowing the original error preserves the request-error path, which is
 * why ky guards on `hookError !== error` (`Ky.js:845`). Only the rethrow
 * reaches `beforeError`, and `beforeError` is what turns the failure into
 * the `APIError` every caller of this transport is written against.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { baseUrl, email } from '@semiont/core';
import { HttpTransport } from '../http-transport';
import { APIError } from '../api-error';

const testBaseUrl = baseUrl('http://localhost:4000');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

/**
 * A `fetch` result ky will treat as an HTTP failure with `status`.
 *
 * Returns a NEW `Response` per call — ky clones the response to build its
 * `HTTPError`, and a single instance reused across attempts fails with
 * "Body has already been consumed" instead of the failure under test.
 */
function failWith(status: number): Response {
  return new Response(JSON.stringify({ message: 'nope' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpTransport retry — what the caller receives', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  test('a POST that got a 502 rejects with the usual APIError, and is sent ONCE', async () => {
    fetchMock.mockImplementation(async () => failWith(502));
    const transport = new HttpTransport({
      baseUrl: testBaseUrl,
      timeout: 10_000,
      tokenRefresher: async () => 'fresh-token',
    });

    const thrown = await transport
      .getMediaToken('res-1' as Parameters<HttpTransport['getMediaToken']>[0])
      .then(() => null)
      .catch((e: unknown) => e);

    // The contract callers are written against, unchanged: `beforeError`
    // still runs, so this is the same `APIError` an unretried failure has
    // always produced — not a TypeError from dereferencing `undefined`, and
    // not a resolved `undefined` masquerading as success.
    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    transport.dispose();
  });

  test('a GET that got a 504 is still retried — one attempt plus one retry', async () => {
    fetchMock.mockResolvedValueOnce(failWith(504));
    fetchMock.mockResolvedValueOnce(okJson({ email: 'a@b.c' }));
    const transport = new HttpTransport({
      baseUrl: testBaseUrl,
      timeout: 10_000,
      tokenRefresher: async () => 'fresh-token',
    });

    await expect(transport.getCurrentUser()).resolves.toMatchObject({ email: 'a@b.c' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    transport.dispose();
  });

  test('a POST that got a 401 is retried once with the refreshed token', async () => {
    fetchMock.mockResolvedValueOnce(failWith(401));
    fetchMock.mockResolvedValueOnce(okJson({ token: 'media-tok' }));
    const transport = new HttpTransport({
      baseUrl: testBaseUrl,
      timeout: 10_000,
      tokenRefresher: async () => 'fresh-token',
    });

    await expect(
      transport.getMediaToken('res-1' as Parameters<HttpTransport['getMediaToken']>[0]),
    ).resolves.toEqual({ token: 'media-tok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const retried = fetchMock.mock.calls[1]![0] as Request;
    expect(retried.headers.get('Authorization')).toBe('Bearer fresh-token');

    transport.dispose();
  });

  test('a failed refresh surfaces the 401 as an APIError, not as a TypeError', async () => {
    // The pre-existing `ky.stop` branch. A refresher that returns null stops
    // the retry, and the caller must still learn the request failed with 401
    // — `ky.stop` alone resolves the promise with `undefined`, so `.json()`
    // then dereferences nothing and the caller catches a TypeError naming an
    // internal instead of an auth failure it can act on.
    fetchMock.mockImplementation(async () => failWith(401));
    const transport = new HttpTransport({
      baseUrl: testBaseUrl,
      timeout: 10_000,
      tokenRefresher: async () => null,
    });

    const thrown = await transport
      .authenticatePassword(email('a@b.c'), 'pw')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).status).toBe(401);

    transport.dispose();
  });

  test('without a refresher, a POST is not retried at all — ky defaults exclude POST', async () => {
    fetchMock.mockImplementation(async () => failWith(503));
    const transport = new HttpTransport({ baseUrl: testBaseUrl, timeout: 10_000 });

    await expect(
      transport.getMediaToken('res-1' as Parameters<HttpTransport['getMediaToken']>[0]),
    ).rejects.toBeInstanceOf(APIError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    transport.dispose();
  });
});
