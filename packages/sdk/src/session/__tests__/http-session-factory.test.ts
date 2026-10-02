/**
 * A session over HTTP, at the level of the requests it makes: what the
 * gateway and the issuer are asked when a session starts on a stored
 * credential. `fetch` is the gateway and the issuer both; nothing is mocked
 * inside the SDK.
 *
 * The case these exist for is the storm one browser tab made
 * (.plans/bugs/stale-sse-actor-401-loops-after-token-expiry.md): an issuer
 * that goes on renewing a credential the gateway goes on refusing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHttpSessionFactory } from '../http-session-factory';
import { SessionSignals } from '../session-signals';
import type { SemiontSessionError } from '../errors';
import { getStoredSession } from '../storage';
import { seedStoredSession, TestStorage, TEST_TOKEN_ENDPOINT } from './test-storage-helpers';

const KB = {
  id: 'kb-a',
  label: 'KB A',
  did: 'did:web:example.github.io:kb-a',
  endpoint: { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const },
};
const GATEWAY = 'http://localhost:4000';

function jwt(n: number): string {
  const part = (value: object) => btoa(JSON.stringify(value));
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: 'none' })}.${part({ iat: now, exp: now + 3600, n })}.sig`;
}

/** Every request made, by where it went. */
let asked: { who: string[]; streams: string[]; renewals: number };
/** Whether the gateway refuses every token. */
let refusesEveryone: boolean;

/** The request's bearer, whichever way `fetch` was given it. */
const bearerOf = (input: string | Request, init?: RequestInit): string => {
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  return (headers.get('authorization') ?? '').replace(/^Bearer /, '');
};

beforeEach(() => {
  asked = { who: [], streams: [], renewals: 0 };
  refusesEveryone = false;
  vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input;
    if (url === TEST_TOKEN_ENDPOINT) {
      // An issuer that renews for as long as it is asked.
      asked.renewals += 1;
      return Response.json({ access_token: jwt(asked.renewals + 1), refresh_token: 'rotated' });
    }
    const total = asked.who.length + asked.streams.length;
    // A session that asks without end is stopped here, by an answer that is no refusal.
    if (total >= 200) return new Response(null, { status: 500 });
    if (url === `${GATEWAY}/api/users/me`) {
      asked.who.push(bearerOf(input, init));
      return refusesEveryone
        ? new Response(null, { status: 401 })
        : Response.json({ did: 'did:web:example.org:users:alice', email: 'alice@example.org', name: 'Alice', image: null, domain: 'example.org' });
    }
    if (url === `${GATEWAY}/bus/subscribe`) {
      asked.streams.push(bearerOf(input, init));
      if (refusesEveryone) return new Response(null, { status: 401 });
      // A stream that stays open and says nothing, until it is aborted.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(null, { status: 404 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settled = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a session over HTTP, starting on a stored credential', () => {
  it('asks the gateway who the token is with one request, and opens one stream: its own', async () => {
    const storage = new TestStorage();
    const stored = jwt(1);
    seedStoredSession(storage, KB.id, stored, 'r');

    const session = createHttpSessionFactory()({ kb: KB, storage, signals: new SessionSignals(), onError: () => {} });
    await session.ready;
    await settled(50);

    expect(session.user$.getValue()).toMatchObject({ name: 'Alice' });
    expect(asked.who).toEqual([stored]);
    // Asking who the token is opened no stream of its own.
    expect(asked.streams).toEqual([stored]);
    await session.dispose();
  });

  it('asks a gateway that refuses what its issuer issues twice, and then leaves it alone', async () => {
    // Time is stepped, so that "left alone" covers many of the waits a
    // stream with no usable credential makes between its checks for one.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    refusesEveryone = true;
    const storage = new TestStorage();
    seedStoredSession(storage, KB.id, jwt(1), 'r');
    const signals = new SessionSignals();
    const errors: SemiontSessionError[] = [];

    const session = createHttpSessionFactory()({ kb: KB, storage, signals, onError: (error) => errors.push(error) });
    await session.ready;

    expect(asked.who).toHaveLength(2);
    expect(signals.sessionExpired$.getValue()).toEqual({
      message: 'This knowledge base did not accept your sign-in. Please sign in again.',
    });
    expect(errors.map((error) => error.code)).toEqual(['session.credential-refused']);
    expect(getStoredSession(storage, KB.id)).toBeNull();

    // And then the gateway and the issuer are left alone: the session's
    // stream asked with the stored token and with the renewed one, and
    // waits for a different credential with no request.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.token$.getValue()).toBeNull();
    expect(asked.who).toHaveLength(2);
    expect(asked.streams.length).toBeLessThanOrEqual(2);
    expect(asked.renewals).toBeLessThanOrEqual(2);
    await session.dispose();
  });
});
