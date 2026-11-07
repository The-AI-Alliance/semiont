/**
 * A session over HTTP, at the level of the requests it makes: what the
 * gateway and the issuer are asked when a session starts on a stored
 * credential. `fetch` is the gateway and the issuer both; nothing is mocked
 * inside the SDK.
 *
 * The case these exist for is the storm one browser tab made:
 * an issuer
 * that goes on renewing a credential the gateway goes on refusing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { filter, firstValueFrom, map, take } from 'rxjs';
import { PERSISTED_QUERIES, resourceId } from '@semiont/core';
import { isReady } from '../../cache';
import { keptPersister } from '../../cache-persister';
import { mockResource } from '../../__tests__/fixtures/resource';
import { createHttpSessionFactory } from '../http-session-factory';
import { createSessionSignals } from '../session-signals';
import type { SemiontSessionError } from '../errors';
import { cacheKey, getStoredSession, lastEventIdKey, personKey, sessionKey } from '../storage';
import { fakeGateway, renews } from './fake-gateway';
import { freshJwt, seedStoredSession, SharedStorage, TestStorage, testSession, TEST_TOKEN_ENDPOINT } from './test-storage-helpers';

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

    const session = createHttpSessionFactory()({ kb: KB, storage, signals: createSessionSignals(), onError: () => {} });
    await session.ready;
    await settled(50);

    expect(session.user$.getValue()).toMatchObject({ name: 'Alice' });
    expect(asked.who).toEqual([stored]);
    // Asking who the token is opened no stream of its own.
    expect(asked.streams).toEqual([stored]);
    session.dispose();
    session.client.dispose();
  });

  it('makes every request of a session with the fetch the factory is given, and none with the runtime\'s', async () => {
    const given = globalThis.fetch;
    const runtimes = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', runtimes);
    const storage = new TestStorage();
    const stored = jwt(1);
    seedStoredSession(storage, KB.id, stored, 'r');

    const session = createHttpSessionFactory(given)({ kb: KB, storage, signals: createSessionSignals(), onError: () => {} });
    await session.ready;
    await settled(50);

    // Who the token is, and the session's stream.
    expect(asked.who).toEqual([stored]);
    expect(asked.streams).toEqual([stored]);
    // And its renewal at the issuer.
    await session.refresh(session.token$.getValue());
    expect(asked.renewals).toBe(1);
    expect(runtimes).not.toHaveBeenCalled();
    session.dispose();
    session.client.dispose();
  });

  it('asks a gateway that refuses what its issuer issues twice, and then leaves it alone', async () => {
    // Time is stepped, so that "left alone" covers many of the waits a
    // stream with no usable credential makes between its checks for one.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    refusesEveryone = true;
    const storage = new TestStorage();
    seedStoredSession(storage, KB.id, jwt(1), 'r');
    const signals = createSessionSignals();
    const errors: SemiontSessionError[] = [];

    const session = createHttpSessionFactory()({ kb: KB, storage, signals, onError: (error) => errors.push(error) });
    await session.ready;

    expect(asked.who).toHaveLength(2);
    expect(signals.sessionEnded$.getValue()).toEqual({ reason: 'refused' });
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
    session.dispose();
    session.client.dispose();
  });

  it('ends a running session whose gateway starts refusing what its issuer issues, on the first refusal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const storage = new TestStorage();
    const stored = jwt(1);
    seedStoredSession(storage, KB.id, stored, 'r');
    const signals = createSessionSignals();
    const errors: SemiontSessionError[] = [];
    const session = createHttpSessionFactory()({ kb: KB, storage, signals, onError: (error) => errors.push(error) });
    await session.ready;
    expect(session.user$.getValue()).toMatchObject({ name: 'Alice' });
    expect(asked.who).toEqual([stored]);

    // The gateway stops accepting anything, and the issuer goes on renewing.
    refusesEveryone = true;
    const refusal = await session.client.auth!.me().then(() => null, (error: unknown) => error);

    // The request, refused; one renewal; the renewed token, asked about once and refused.
    expect(refusal).toMatchObject({ status: 401 });
    expect(asked.renewals).toBe(1);
    expect(asked.who).toHaveLength(3);
    expect(asked.who[1]).toBe(stored);
    expect(asked.who[2]).not.toBe(stored);
    expect(signals.sessionEnded$.getValue()).toEqual({ reason: 'refused' });
    expect(errors.map((error) => error.code)).toEqual(['session.credential-refused']);
    expect(getStoredSession(storage, KB.id)).toBeNull();
    expect(session.token$.getValue()).toBeNull();

    // A request after that is refused as it is: nothing is renewed for it,
    // and nobody is asked who anyone is.
    await session.client.auth!.me().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(asked.renewals).toBe(1);
    expect(asked.who).toHaveLength(4);
    expect(errors).toHaveLength(1);
    session.dispose();
    session.client.dispose();
  });
});

describe('a session over HTTP whose gateway names its person only after it has started', () => {
  const ALICE = { did: 'did:web:example.org:users:alice', email: 'alice@example.org', name: 'Alice', image: null, domain: 'example.org' };

  it("records the person on the stored sign-in when a renewal's ask names them, and reads what is kept for them then", async () => {
    const storage = new SharedStorage();
    const alice = personKey(ALICE.did);
    keptPersister('resource', { storage, kbId: KB.id, personKey: alice })
      .save(new Map([[resourceId('res-1'), mockResource('res-1', { name: 'kept' })]]));
    storage.set(sessionKey(KB.id), JSON.stringify(testSession(freshJwt(), 'r')));
    let reachable = false;
    const gateway = fakeGateway({
      whoIs: async () => {
        if (!reachable) throw new TypeError('fetch failed');
        return Response.json(ALICE);
      },
      issuer: renews,
      resourceName: 'fresh',
    });

    const session = createHttpSessionFactory(gateway.fetch)({ kb: KB, storage, signals: createSessionSignals(), onError: () => {} });
    try {
      // The start could not ask who the token is: nobody is recorded.
      await session.ready;
      expect(getStoredSession(storage, KB.id)?.personKey).toBeUndefined();

      // A refusal renews the token, and the gateway is asked who the renewed one is.
      reachable = true;
      await session.refresh(session.token$.getValue());
      await vi.waitFor(() => expect(getStoredSession(storage, KB.id)?.personKey).toBe(alice));

      const read = await firstValueFrom(
        session.client.browse.resource(resourceId('res-1')).pipe(filter(isReady), map((state) => state.value.name), take(1)),
      );
      expect(read).toBe('kept');
    } finally {
      session.dispose();
      session.client.dispose();
      gateway.close();
    }
  });
});

describe('a session over HTTP whose stored sign-in cannot be read as its client writes', () => {
  const JO = { did: 'did:web:example.org:users:jo', email: 'jo@example.org', name: 'Jo', image: null, domain: 'example.org' };

  /** A storage whose read of the knowledge base's stored sign-in fails while `failing` is set. */
  class FailingStorage extends SharedStorage {
    failing = false;
    failures = 0;

    override get(key: string): string | null {
      if (this.failing && key === sessionKey(KB.id)) {
        this.failures += 1;
        throw new Error('the stored sign-in could not be read');
      }
      return super.get(key);
    }
  }

  it("reads it as naming nobody: the client writes nothing more for its life, and the session's errors say so once, as session.keep-failed", async () => {
    const storage = new FailingStorage();
    const jo = personKey(JO.did);
    /** Every key the client keeps jo's under: the stream's places, and each persisted query's. */
    const josKeys = [lastEventIdKey(KB.id, jo), ...PERSISTED_QUERIES.map((query) => cacheKey(KB.id, jo, query))];
    let josBefore: (string | null)[] = [];
    storage.set(sessionKey(KB.id), JSON.stringify({ ...testSession(freshJwt(), 'r'), personKey: jo }));
    const gateway = fakeGateway({ whoIs: async () => Response.json(JO), issuer: renews, resourceName: 'fresh' });
    const errors: SemiontSessionError[] = [];
    const session = createHttpSessionFactory(gateway.fetch)({ kb: KB, storage, signals: createSessionSignals(), onError: (error) => errors.push(error) });
    const nameOf = (id: string): Promise<string> =>
      firstValueFrom(session.client.browse.resource(resourceId(id)).pipe(filter(isReady), map((state) => state.value.name), take(1)));
    try {
      await session.ready;
      // A value the client holds unwritten, whose save finds the stored sign-in unreadable.
      josBefore = josKeys.map((key) => storage.get(key));
      storage.failing = true;
      expect(await nameOf('res-1')).toBe('fresh');
      await vi.waitFor(() => expect(storage.failures).toBeGreaterThan(0));
      // Readable again, and naming jo still: the client writes nothing all the same.
      storage.failing = false;
      expect(await nameOf('res-2')).toBe('fresh');
    } finally {
      session.dispose();
      session.client.dispose();
      gateway.close();
    }

    expect(storage.get(cacheKey(KB.id, jo, 'resource'))).toBeNull();
    // Nothing was written for jo after the sign-in could not be read, closing included.
    expect(josKeys.map((key) => storage.get(key))).toEqual(josBefore);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('session.keep-failed');
    expect(errors[0]?.kbId).toBe(KB.id);
  });
});
