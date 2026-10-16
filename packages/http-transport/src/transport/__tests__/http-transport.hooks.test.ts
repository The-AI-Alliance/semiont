/**
 * Behavior tests for HttpTransport's `ky` hooks.
 *
 * The wire-shape suite (`http-transport.http-paths.test.ts`) mocks `ky.create`,
 * so the hooks it is handed never actually run — leaving the behavior-bearing
 * `beforeError` path (HTTP failure -> `APIError` on the public `errors$` stream
 * + thrown) and the `afterResponse` passthrough uncovered.
 *
 * These tests capture the `hooks` object passed into `ky.create` and invoke the
 * hooks directly, each with the single state-object argument ky 2 hands a hook.
 * `ky.retry` is mocked to hand back what it was asked for, so a hook that
 * forces a resend says how.
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
  class NetworkError extends Error {
    override name = 'NetworkError';
  }
  class TimeoutError extends Error {
    override name = 'TimeoutError';
  }
  return {
    default: { create: vi.fn(), retry: vi.fn((options: unknown) => ({ forced: options })) },
    HTTPError,
    NetworkError,
    TimeoutError,
  };
});

import ky, { HTTPError, NetworkError, TimeoutError } from 'ky';
import { RETRY_RULES } from '@semiont/core';
import { HttpTransport } from '../http-transport';
import { APIError } from '../api-error';

const testBaseUrl = baseUrl('http://localhost:4000');

type ResponseLike = { status: number; statusText: string; headers: Headers };

/**
 * An object that passes `instanceof HTTPError`, as ky hands one to a hook:
 * its `.response`, whose body ky has already read, and that body as `.data`
 * (`http-transport.retry.test.ts` holds the same through real ky).
 */
function httpError(response: ResponseLike, data: unknown): Error {
  const err = Object.create(HTTPError.prototype) as Error;
  return Object.assign(err, { response, data });
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

    const error = httpError(
      { headers: new Headers(), status: 404, statusText: 'Not Found' },
      { error: 'Resource missing' },
    );

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

    const error = httpError(
      { headers: new Headers(), status: 503, statusText: 'Service Unavailable' },
      undefined,
    );

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

  test.each([
    ['the connection failed', () => Object.assign(Object.create(NetworkError.prototype) as Error, { message: 'fetch failed', name: 'NetworkError' })],
    ['the deadline passed', () => Object.assign(Object.create(TimeoutError.prototype) as Error, { message: 'Request timed out', name: 'TimeoutError' })],
  ])('beforeError reports a request the gateway never answered (%s) as unavailable, on errors$, and throws it', async (_why, unanswered) => {
    const beforeError = hooks.beforeError![0]!;
    type State = Parameters<typeof beforeError>[0];
    const emitted: SemiontError[] = [];
    const sub = transport.errors$.subscribe((e) => emitted.push(e));

    const thrown = await Promise.resolve(
      beforeError({
        request: { method: 'GET', url: 'http://localhost:4000/api/status' } as unknown as State['request'],
        options: {} as unknown as State['options'],
        error: unanswered(),
        retryCount: 0,
      }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    sub.unsubscribe();

    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).code).toBe('unavailable');
    expect((thrown as APIError).message).toMatch(/^GET \/api\/status got no answer: /);
    expect(emitted).toEqual([thrown]);
  });

  test('beforeError passes an error that is neither through untouched (no emission)', async () => {
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

// ── shouldRetry is the retry gate ───────────────────────────────────────
// ky's `methods`/`statusCodes` are ANDed independently — there is no
// per-status method list, so "every status but one on idempotent methods
// only" cannot be said with them. `shouldRetry` says it instead, deriving
// from `RETRY_RULES.transport` rather than restating a set of numbers, and
// asks the rule nothing about a refused credential, which is renewed or final.
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

  /** Ask the gate about a request of `method` that failed with `status`, and the body ky read. */
  function verdict(method: string, status: number, data?: unknown) {
    const error = Object.assign(httpError({ status, statusText: 'x', headers: new Headers() }, data), {
      request: { method },
    });
    return shouldRetry({ error, retryCount: 1 });
  }

  test('a POST that got a 504 is NOT retried — it may already have been processed', () => {
    expect(verdict('POST', 504)).toBe(false);
  });

  test('a POST that got a 502 is NOT retried — the upload case that bites', () => {
    // `POST /resources` mints a fresh UUID in the Stower, so a duplicate
    // writes a second resource the caller never learns about.
    expect(verdict('POST', 502)).toBe(false);
  });

  test('a refused credential is never retried, whatever the method — it is renewed, or final', () => {
    // The renewal is the `afterResponse` hook's forced resend, which does not
    // ask this gate; what reaches the gate is a refusal nothing renewed.
    expect(verdict('POST', 401)).toBe(false);
    expect(verdict('GET', 401)).toBe(false);
    // A 429 `refusal-rate` says what a 401 says: the rule would retry it
    // after its Retry-After, with the token refused.
    expect(verdict('GET', 429, { error: 'refused', code: 'refusal-rate' })).toBe(false);
  });

  test('a GET that met a limit is still the rule\'s to retry', () => {
    expect(verdict('GET', 429, { error: 'slow down', code: 'emit-rate' })).toBeUndefined();
  });

  test('a GET that got a 504 is retried — the gate must not over-narrow', () => {
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

describe('HttpTransport afterResponse — a refused credential is renewed once, at once', () => {
  function build(refresher: () => Promise<string | null>) {
    vi.mocked(ky.create).mockReturnValue({
      get: vi.fn(),
      post: vi.fn(),
    } as unknown as ReturnType<typeof ky.create>);
    vi.mocked(ky.create).mockClear();
    vi.mocked(ky.retry).mockClear();
    new HttpTransport({ baseUrl: testBaseUrl, timeout: 10_000, tokenRefresher: refresher });
    const hooks = vi.mocked(ky.create).mock.calls.at(-1)![0]!.hooks!;
    // [0] is the logging passthrough; [1] renews.
    const renew = hooks.afterResponse![1]!;
    type State = Parameters<typeof renew>[0];
    const request = { method: 'POST', headers: new Headers({ Authorization: 'Bearer refused-token' }) } as unknown as State['request'];
    return {
      request,
      run: (response: Response, retryCount = 0) =>
        renew({
          request,
          options: {} as unknown as State['options'],
          response: response as State['response'],
          retryCount,
        }),
    };
  }

  const refusedToken = () => new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 });
  const refusedByRate = (code: string) => new Response(JSON.stringify({ error: 'refused', code }), { status: 429 });

  test('a 401 is sent again at once with the renewed token', async () => {
    const { request, run } = build(async () => 'fresh-token');
    await expect(run(refusedToken())).resolves.toEqual({ forced: { delay: 0, code: 'credential-renewed' } });
    expect(request.headers.get('Authorization')).toBe('Bearer fresh-token');
  });

  test('a 429 refusal-rate is a refused credential: renewed the same way, not waited out', async () => {
    const { request, run } = build(async () => 'fresh-token');
    await expect(run(refusedByRate('refusal-rate'))).resolves.toEqual({ forced: { delay: 0, code: 'credential-renewed' } });
    expect(request.headers.get('Authorization')).toBe('Bearer fresh-token');
  });

  test('a 429 from any other limit is not renewed: the refresher is not asked', async () => {
    const refresher = vi.fn(async () => 'fresh-token');
    const { run } = build(refresher);
    await expect(run(refusedByRate('emit-rate'))).resolves.toBeUndefined();
    expect(refresher).not.toHaveBeenCalled();
  });

  test.each([
    ['gives no token', async () => null],
    ['gives the token refused', async () => 'refused-token'],
    ['throws', async (): Promise<string | null> => { throw new Error('refresh endpoint down'); }],
  ])('a refresher that %s leaves the refusal to fail, and nothing is sent again', async (_what, refresher) => {
    const { request, run } = build(refresher);
    await expect(run(refusedToken())).resolves.toBeUndefined();
    expect(ky.retry).not.toHaveBeenCalled();
    expect(request.headers.get('Authorization')).toBe('Bearer refused-token');
  });

  test('the renewed request refused again is not renewed again: the refresher is asked once', async () => {
    const refresher = vi.fn(async () => 'another-token');
    const { run } = build(refresher);
    await expect(run(refusedToken(), 1)).resolves.toBeUndefined();
    expect(refresher).not.toHaveBeenCalled();
  });
});

// ── The actor→transport errors$ bridge ──────────────────────────────────
// A refused SSE connect is an HTTP failure like any other, so it belongs on
// the transport's contract `errors$` stream — not only on the actor's. This
// pin drives a REAL actor connect (global fetch is stubbed by the mock-conn
// harness; the ky mock above is irrelevant to the SSE path).

import { BehaviorSubject } from 'rxjs';
import { Bus, accessToken, type AccessToken } from '@semiont/core';
import { mockFetch } from './helpers/mock-conn';

describe('HttpTransport errors$ bridge (SSE connect refusals)', () => {
  test('a refused SSE connect surfaces on the transport errors$ under the code its status maps to', async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => ({ ok: false, headers: new Headers(), status: 401, body: null }));

    const transport = new HttpTransport({
      baseUrl: testBaseUrl,
      timeout: 10_000,
      token$: new BehaviorSubject<AccessToken | null>(accessToken('real-but-refused-tok')),
    });
    const seen: SemiontError[] = [];
    transport.errors$.subscribe((e) => seen.push(e));

    // The transport was made with a token, and opened its stream then.
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    // The error a refused request is, with a code from
    // specs/src/errors/codes.json: a consumer routing on `unauthorized` hears
    // a refused stream as it hears a refused request.
    expect(seen[0]).toBeInstanceOf(APIError);
    expect((seen[0] as APIError).status).toBe(401);
    expect(seen[0]!.code).toBe('unauthorized');

    transport.dispose();
  });
});

describe('HttpTransport errors$ bridge (refused emits)', () => {
  test('an emit the gateway refuses is reported on errors$ and thrown to its caller, as one error', async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers(),
      text: async () => 'payload does not match',
    }));

    // No token: the stream never opens, so the only request is the emit.
    const transport = new HttpTransport({ baseUrl: testBaseUrl, timeout: 10_000 });
    const seen: SemiontError[] = [];
    transport.errors$.subscribe((e) => seen.push(e));

    const thrown = await transport.emit('beckon:focus', {}).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).code).toBe('bad-request');
    expect(seen).toEqual([thrown]);

    transport.dispose();
  });
});

describe('HttpTransport after dispose', () => {
  const request = (transport: HttpTransport) =>
    new Bus(transport).request('browse:resource-requested', { resourceId: 'r' }, 200).catch((error: unknown) => error);

  test('a request fails as closed at once: the transport does not build itself a new, unopened bus to wait on', async () => {
    mockFetch.mockReset();
    const transport = new HttpTransport({ baseUrl: testBaseUrl, timeout: 10_000 });
    // Its bus is made before it is disposed: something asked for the connection's state.
    transport.state$.subscribe().unsubscribe();
    transport.dispose();

    expect(await request(transport)).toMatchObject({ code: 'bus.closed' });
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/bus/emit'))).toEqual([]);
  });

  test('the same holds for a transport disposed before it ever touched its bus', async () => {
    mockFetch.mockReset();
    const transport = new HttpTransport({ baseUrl: testBaseUrl, timeout: 10_000 });
    transport.dispose();

    expect(await request(transport)).toMatchObject({ code: 'bus.closed' });
  });
});
