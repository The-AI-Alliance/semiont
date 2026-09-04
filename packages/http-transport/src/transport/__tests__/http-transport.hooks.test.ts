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
import { HttpTransport, APIError } from '../http-transport';

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
