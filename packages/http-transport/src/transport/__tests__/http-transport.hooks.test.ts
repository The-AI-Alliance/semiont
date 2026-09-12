/**
 * Behavior tests for HttpTransport's `ky` hooks.
 *
 * The wire-shape suite (`http-transport.http-paths.test.ts`) mocks `ky.create`,
 * so the hooks it is handed never actually run — leaving the behavior-bearing
 * `beforeError` path (HTTP failure -> `APIError` on the public `errors$` stream
 * + thrown) and the `afterResponse` passthrough uncovered.
 *
 * These tests capture the `hooks` object passed into `ky.create` and invoke the
 * hooks directly. Added alongside the ky 1 -> 2 migration, which moved every
 * hook to a single state-object argument.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { baseUrl, type SemiontError } from '@semiont/core';

// Mock `ky` with a real `HTTPError` class — defined *inside* the factory to
// avoid vitest's mock-hoisting TDZ — so the hook's `error instanceof HTTPError`
// narrowing resolves against the same class the test constructs.
vi.mock('ky', () => {
  class HTTPError extends Error {
    response: unknown;
    constructor(response: unknown) {
      super('HTTP Error');
      this.name = 'HTTPError';
      this.response = response;
    }
  }
  return {
    default: { create: vi.fn(), stop: Symbol('ky.stop') },
    HTTPError,
  };
});

import ky, { HTTPError } from 'ky';
import { RETRY_RULES } from '@semiont/core';
import { HttpTransport } from '../http-transport';
import { APIError } from '../api-error';

const testBaseUrl = baseUrl('http://localhost:4000');

type ResponseLike = { status: number; statusText: string; json: () => Promise<unknown> };

/** An object that passes `instanceof HTTPError` and carries a `.response`. */
function httpError(response: ResponseLike): Error {
  const err = Object.create(HTTPError.prototype) as Error;
  return Object.assign(err, { response });
}

describe('HttpTransport ky hooks', () => {
  let transport: HttpTransport;
  let hooks: NonNullable<NonNullable<Parameters<typeof ky.create>[0]>['hooks']>;

  beforeEach(() => {
    vi.mocked(ky.create).mockReturnValue({
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReturnType<typeof ky.create>);

    vi.mocked(ky.create).mockClear();
    transport = new HttpTransport({ baseUrl: testBaseUrl, timeout: 10_000 });
    hooks = vi.mocked(ky.create).mock.calls.at(-1)![0]!.hooks!;
  });

  test('beforeError turns an HTTP error into an APIError on errors$ and throws it', async () => {
    const beforeError = hooks.beforeError![0]!;
    type State = Parameters<typeof beforeError>[0];

    const error = httpError({
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ message: 'Resource missing' }),
    });

    const emitted: SemiontError[] = [];
    const sub = transport.errors$.subscribe((e) => emitted.push(e));

    const state = {
      request: {} as unknown as State['request'],
      options: {} as unknown as State['options'],
      error,
      retryCount: 0,
    };

    await expect(beforeError(state)).rejects.toBeInstanceOf(APIError);
    sub.unsubscribe();

    expect(emitted).toHaveLength(1);
    const apiError = emitted[0]!;
    expect(apiError).toBeInstanceOf(APIError);
    expect((apiError as APIError).status).toBe(404);
    expect((apiError as APIError).statusText).toBe('Not Found');
    expect(apiError.message).toBe('Resource missing');
  });

  test('beforeError falls back to a status message when the body has none', async () => {
    const beforeError = hooks.beforeError![0]!;
    type State = Parameters<typeof beforeError>[0];

    const error = httpError({
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    });

    const emitted: SemiontError[] = [];
    const sub = transport.errors$.subscribe((e) => emitted.push(e));

    await expect(
      beforeError({
        request: {} as unknown as State['request'],
        options: {} as unknown as State['options'],
        error,
        retryCount: 0,
      }),
    ).rejects.toThrow('HTTP 503: Service Unavailable');
    sub.unsubscribe();

    expect(emitted).toHaveLength(1);
  });

  test('beforeError passes a non-HTTP error through untouched (no emission)', async () => {
    const beforeError = hooks.beforeError![0]!;
    type State = Parameters<typeof beforeError>[0];

    const plain = new Error('socket hang up');
    const emitted: SemiontError[] = [];
    const sub = transport.errors$.subscribe((e) => emitted.push(e));

    const returned = await beforeError({
      request: {} as unknown as State['request'],
      options: {} as unknown as State['options'],
      error: plain,
      retryCount: 0,
    });

    sub.unsubscribe();
    expect(returned).toBe(plain);
    expect(emitted).toHaveLength(0);
  });

  test('afterResponse returns the response unchanged', async () => {
    const afterResponse = hooks.afterResponse![0]!;
    type State = Parameters<typeof afterResponse>[0];

    const response = { status: 200, statusText: 'OK' } as unknown as State['response'];

    const returned = await afterResponse({
      request: {} as unknown as State['request'],
      options: {} as unknown as State['options'],
      response,
      retryCount: 0,
    });

    expect(returned).toBe(response);
  });
});

// ── RETRY-CLASSIFICATION P3: shouldRetry is the retry gate ──────────────
// ky's `methods`/`statusCodes` are ANDed independently — there is no
// per-status method list, so "the widened methods apply to 401 only" cannot
// be said with them. `shouldRetry` says it instead, deriving from
// `RETRY_RULES.transport` rather than restating a set of numbers.
//
// The gate is here and not in `beforeRetry` because ky awaits the full
// backoff before running that hook: a rejection there would sleep first.
// ky's own docs draw the same line — `shouldRetry` controls WHETHER,
// `beforeRetry` runs after a retry is confirmed to modify the request.
//
// These tests read the decision directly. What a rejected retry looks like
// to a caller is `http-transport.retry.test.ts`, which drives real ky.

describe('HttpTransport shouldRetry — the transport retry rule', () => {
  let shouldRetry: (state: { error: Error; retryCount: number }) => false | undefined;
  let retryConfig: { statusCodes: number[] };

  beforeEach(() => {
    vi.mocked(ky.create).mockReturnValue({
      get: vi.fn(),
      post: vi.fn(),
    } as unknown as ReturnType<typeof ky.create>);
    vi.mocked(ky.create).mockClear();

    new HttpTransport({
      baseUrl: testBaseUrl,
      timeout: 10_000,
      tokenRefresher: async () => 'fresh-token',
    });
    retryConfig = vi.mocked(ky.create).mock.calls.at(-1)![0]!.retry as typeof retryConfig;
    shouldRetry = (retryConfig as unknown as { shouldRetry: typeof shouldRetry }).shouldRetry;
  });

  /** Ask the gate about a request of `method` that failed with `status`. */
  function verdict(method: string, status: number) {
    const error = Object.assign(httpError({ status, statusText: 'x', json: async () => ({}) }), {
      request: { method },
    });
    return shouldRetry({ error, retryCount: 1 });
  }

  test('a POST that got a 504 is NOT retried — it may already have been processed', () => {
    expect(verdict('POST', 504)).toBe(false);
  });

  test('a POST that got a 502 is NOT retried — the upload case that bites', () => {
    // `POST /resources` mints a fresh UUID in the Stower, so a duplicate
    // writes a second resource the caller never learns about (P0 row 8).
    expect(verdict('POST', 502)).toBe(false);
  });

  test('a POST that got a 401 is left to ky — token refresh survives', () => {
    // `undefined`, not `true`: the gate only ever narrows, so ky's own
    // checks still run and `beforeRetry` still gets to refresh the token.
    expect(verdict('POST', 401)).toBeUndefined();
  });

  test('a GET that got a 504 is still retried — the fix must not over-narrow', () => {
    expect(verdict('GET', 504)).toBeUndefined();
  });

  test('a PATCH that got a 500 is NOT retried, and a PUT that got a 500 is', () => {
    // The axis is idempotency, not "POST is special": PUT is repeatable by
    // RFC 9110 and PATCH is not, so they part company on the same status.
    expect(verdict('PATCH', 500)).toBe(false);
    expect(verdict('PUT', 500)).toBeUndefined();
  });

  test('a 413 is never force-retried — ky keeps its retry-timing-header rule', () => {
    // The gate returns `undefined` rather than `true` for an approved
    // status, so ky still retries 413 only when the response says when.
    expect(verdict('GET', 413)).toBeUndefined();
  });

  test('a non-HTTP error (socket hang up) is left to ky to decide', () => {
    // No status to classify. The rule answers only about statuses; transport
    // faults are ky's own retry domain and stay there.
    expect(shouldRetry({ error: new Error('socket hang up'), retryCount: 1 })).toBeUndefined();
  });

  test('census: ky\'s statusCodes stay a SUPERSET of what the rule can approve', () => {
    // The gate can only reject what ky admits — a status the rule would
    // approve but the pre-filter omits is never retried, and nothing else
    // would fail. So the two may differ, but only in one direction.
    const admitted = new Set(retryConfig.statusCodes);

    const approved = [];
    for (let status = 400; status < 600; status++) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        if (RETRY_RULES.transport.retryable({ status, method })) approved.push(status);
      }
    }

    expect(approved.length).toBeGreaterThan(0);
    expect([...new Set(approved)].filter((s) => !admitted.has(s))).toEqual([]);
  });
});

describe('HttpTransport beforeRetry — refresh only, once a retry is confirmed', () => {
  let hooks: NonNullable<NonNullable<Parameters<typeof ky.create>[0]>['hooks']>;

  function build(refresher: () => Promise<string | null>) {
    vi.mocked(ky.create).mockReturnValue({
      get: vi.fn(),
      post: vi.fn(),
    } as unknown as ReturnType<typeof ky.create>);
    vi.mocked(ky.create).mockClear();
    new HttpTransport({ baseUrl: testBaseUrl, timeout: 10_000, tokenRefresher: refresher });
    hooks = vi.mocked(ky.create).mock.calls.at(-1)![0]!.hooks!;
    const beforeRetry = hooks.beforeRetry![0]!;
    type State = Parameters<typeof beforeRetry>[0];
    const request = { method: 'POST', headers: new Headers() } as unknown as State['request'];
    const error = httpError({ status: 401, statusText: 'x', json: async () => ({}) });
    return {
      request,
      error,
      run: () =>
        beforeRetry({
          request,
          options: {} as unknown as State['options'],
          error,
          retryCount: 1,
        }),
    };
  }

  test('a 401 gets the refreshed credential on the outgoing request', async () => {
    const { request, run } = build(async () => 'fresh-token');
    await expect(run()).resolves.toBeUndefined();
    expect(request.headers.get('Authorization')).toBe('Bearer fresh-token');
  });

  test('a refresher that returns null rethrows the original error, never ky.stop', async () => {
    // `ky.stop` would resolve the caller's promise with `undefined`; the
    // rethrow keeps ky's request-error path so `beforeError` still runs.
    const { error, run } = build(async () => null);
    await expect(run()).rejects.toBe(error);
  });

  test('a refresher that throws also rethrows the original error', async () => {
    const { error, run } = build(async () => {
      throw new Error('refresh endpoint down');
    });
    // The caller learns the request failed with 401 — the reason the refresh
    // itself failed is the session's problem, not this request's.
    await expect(run()).rejects.toBe(error);
  });
});

// ── SSE-AUTH-RESILIENCE P4: the actor→transport errors$ bridge ──────────
// A refused SSE connect is an HTTP failure like any other, so it belongs on
// the transport's contract `errors$` stream — not only on the actor's. This
// pin drives a REAL actor connect (global fetch is stubbed by the mock-conn
// harness; the ky mock above is irrelevant to the SSE path).

import { BehaviorSubject } from 'rxjs';
import { accessToken, type AccessToken } from '@semiont/core';
import { SseConnectError } from '../sse-connect-error';
import { mockFetch } from './helpers/mock-conn';

describe('HttpTransport errors$ bridge (SSE connect refusals)', () => {
  test('a refused SSE connect surfaces on the transport errors$ as a SseConnectError', async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => ({ ok: false, status: 401, body: null }));

    const transport = new HttpTransport({
      baseUrl: testBaseUrl,
      timeout: 10_000,
      token$: new BehaviorSubject<AccessToken | null>(accessToken('real-but-refused-tok')),
    });
    const seen: SemiontError[] = [];
    transport.errors$.subscribe((e) => seen.push(e));

    transport.actor.start();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBeInstanceOf(SseConnectError);
    expect((seen[0] as SseConnectError).status).toBe(401);

    transport.dispose();
  });
});
