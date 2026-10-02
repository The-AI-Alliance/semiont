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
import { accessToken, baseUrl, resourceId } from '@semiont/core';
import { HttpTransport, currentUserOf } from '../http-transport';
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
      .getMediaToken(resourceId('r1'))
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

/** A refusal as the gateway states one: `ErrorResponse`, whose `error` is its own words. */
function refusedAs(status: number, statusText: string, error: string): Response {
  return new Response(JSON.stringify({ error, hint: 'a hint' }), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpTransport — what a refusal says', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  test("a refusal carries the gateway's own words and its body, on the error and on errors$", async () => {
    fetchMock.mockImplementation(async () => refusedAs(403, 'Forbidden', 'this needs the moderator role'));
    const transport = new HttpTransport({ baseUrl: testBaseUrl, timeout: 10_000 });
    const reported: unknown[] = [];
    transport.errors$.subscribe((error) => reported.push(error));

    const thrown = await transport.getCurrentUser().then(() => null, (e: unknown) => e);

    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).message).toBe('this needs the moderator role');
    expect((thrown as APIError).status).toBe(403);
    expect((thrown as APIError).details).toMatchObject({
      status: 403,
      statusText: 'Forbidden',
      body: { error: 'this needs the moderator role', hint: 'a hint' },
    });
    expect(reported).toEqual([thrown]);
    transport.dispose();
  });

  test('a refusal that states nothing is named by its status', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>bad gateway</html>', { status: 403, statusText: 'Forbidden' }));
    const transport = new HttpTransport({ baseUrl: testBaseUrl, timeout: 10_000 });

    const thrown = await transport.getCurrentUser().then(() => null, (e: unknown) => e);

    expect((thrown as APIError).message).toBe('HTTP 403: Forbidden');
    transport.dispose();
  });
});

/**
 * `currentUserOf`: who a token is, asked by a caller that holds nothing else.
 * A session asks this of a stored credential. It must be exactly one request:
 * a transport built for the asking opens a bus stream the moment it has a
 * token, and a session that asked in a loop sent one of each per round.
 */
describe('currentUserOf — one request, and no transport behind it', () => {
  const sent = (): Request => fetchMock.mock.calls[0]![0] as Request;

  beforeEach(() => {
    fetchMock.mockReset();
  });

  test('asks /api/users/me with the token, once, and opens no stream', async () => {
    fetchMock.mockImplementation(async () => okJson({ email: 'a@b.c' }));

    await expect(currentUserOf(baseUrl('http://localhost:4000/'), accessToken('tok-1'))).resolves.toMatchObject({ email: 'a@b.c' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().url).toBe('http://localhost:4000/api/users/me');
    expect(sent().method).toBe('GET');
    expect(sent().headers.get('authorization')).toBe('Bearer tok-1');
  });

  test('a refusal is the answer: the usual APIError with its status, and nothing renews the token', async () => {
    fetchMock.mockImplementation(async () => refusedAs(401, 'Unauthorized', 'the token is not one this gateway accepts'));

    const thrown = await currentUserOf(testBaseUrl, accessToken('tok-1')).then(() => null, (e: unknown) => e);

    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).status).toBe(401);
    expect((thrown as APIError).message).toBe('the token is not one this gateway accepts');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a gateway that never answers is reported as unavailable, not as a refusal', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('fetch failed'); });

    const thrown = await currentUserOf(testBaseUrl, accessToken('tok-1')).then(() => null, (e: unknown) => e);

    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).code).toBe('unavailable');
    expect((thrown as APIError).message).toContain('GET /api/users/me got no answer');
  });
});

