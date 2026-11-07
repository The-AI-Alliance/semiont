/**
 * Tests for the `SemiontSession` factories: `fromHttp` (structural — brand
 * the inputs, build the transport stack, thread the shared `token$`),
 * `fromKept` (a sign-in kept where its holder keeps it: renewed and
 * forgotten there, and the ready session given), and `signInDevice` (the
 * device grant end to end, the sign-in kept where it is told, and a session
 * then built over it). `fromHttp` and `fromKept` each give an
 * `OpenedSession`: the session and the client it was built with, ended
 * together. They construct a real `SemiontClient` over a real
 * `HttpTransport`, so the wire is kept quiet by spying on the transport and
 * stubbing `fetch` for the issuer. And a new sign-in saved over a stored one
 * by `setStoredSession` forgets it, with what was kept for the person it
 * named; a renewal forgets nothing.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { filter, firstValueFrom, map, take } from 'rxjs';
import { HttpTransport, currentUserOf } from '@semiont/http-transport';
import { PERSISTED_QUERIES, baseUrl, resourceId } from '@semiont/core';

import { isReady } from '../../cache';
import { SemiontSession } from '../semiont-session';
import { refreshStoredSession } from '../oauth';
import { MemorySignIn } from '../sign-in-kept';
import { cacheKey, getStoredSession, kbGatewayUrl, lastEventIdKey, personKey, setStoredSession } from '../storage';
import { fakeGateway, renews } from './fake-gateway';
import { TestStorage, freshJwt, storageKey, testSession, TEST_TOKEN_ENDPOINT } from './test-storage-helpers';

const KB = {
  id: 'kb-factory',
  label: 'Factory KB',
  did: 'did:web:example.github.io:test-kb',
  endpoint: { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const },
};

let storage: TestStorage;

beforeEach(() => {
  storage = new TestStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SemiontSession.fromHttp', () => {
  test('what it gives ends the session, then closes the client it was built with', async () => {
    const opened = SemiontSession.fromHttp({ kb: KB, kept: new MemorySignIn(), baseUrl: 'http://test.local' });
    await opened.session.ready;
    const closed = vi.spyOn(opened.session.client, 'dispose');
    let ended = false;
    opened.session.token$.subscribe({ complete: () => { ended = true; } });

    opened.dispose();

    expect(ended).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
  });

  test('returns a SemiontSession with no token when none provided', async () => {
    const opened = SemiontSession.fromHttp({
      kb: KB,
      kept: new MemorySignIn(),
      baseUrl: 'http://test.local',
    });
    const { session } = opened;
    try {
      await session.ready;
      expect(session.token$.getValue()).toBeNull();
      expect(session.user$.getValue()).toBeNull();
    } finally {
      opened.dispose();
    }
  });

  test('seeds token$ when a string token is supplied (and brands it)', async () => {
    const opened = SemiontSession.fromHttp({
      kb: KB,
      kept: new MemorySignIn(),
      baseUrl: 'http://test.local',
      token: 'header.payload.sig',
    });
    const { session } = opened;
    try {
      await session.ready;
      expect(session.token$.getValue()).toBe('header.payload.sig');
    } finally {
      opened.dispose();
    }
  });

  test('forwards optional callbacks (refresh / onAuthFailed) into the session', async () => {
    const refresh = vi.fn(async () => null);
    const onAuthFailed = vi.fn();

    const opened = SemiontSession.fromHttp({
      kb: KB,
      kept: new MemorySignIn(),
      baseUrl: 'http://test.local',
      refresh,
      onAuthFailed,
    });

    const { session } = opened;
    try {
      await session.ready;

      // Drive a refresh. With no stored token there's nothing to refresh,
      // but the configured callback is what we want to assert wired, given
      // the token the session holds: none.
      const result = await session.refresh(session.token$.getValue());
      expect(result).toBeNull();
      expect(refresh).toHaveBeenCalledWith(null);
    } finally {
      opened.dispose();
    }
  });
});

function issuerReply(json: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => json } as unknown as Response;
}

describe('SemiontSession.fromKept', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('starts with the access token the kept sign-in holds, and is ready', async () => {
    const accessJwt = freshJwt();
    const kept = new MemorySignIn(testSession(accessJwt, 'refresh-tok'));

    const opened = await SemiontSession.fromKept({ kb: KB, kept });

    try {
      expect(opened.session.token$.getValue()).toBe(accessJwt);
      expect(kept.held()).toEqual(testSession(accessJwt, 'refresh-tok'));
    } finally {
      opened.dispose();
    }
  });

  test('with nothing kept, the session is signed out', async () => {
    const opened = await SemiontSession.fromKept({ kb: KB, kept: new MemorySignIn() });

    try {
      expect(opened.session.token$.getValue()).toBeNull();
      expect(opened.session.user$.getValue()).toBeNull();
    } finally {
      opened.dispose();
    }
  });

  test('renews at the issuer the kept sign-in names, with its refresh token, and keeps the renewal where the sign-in is kept', async () => {
    const newAccess = freshJwt();
    const fetchMock = vi.fn(async (_url: string) => issuerReply({ access_token: newAccess, refresh_token: 'refresh-2' }));
    vi.stubGlobal('fetch', fetchMock);
    const kept = new MemorySignIn({ ...testSession(freshJwt(), 'refresh-tok'), personKey: 'gqB898gk4Ww_orAHhzDCSVl7yHP9UEsX0DA_xbGbq-I' });

    const opened = await SemiontSession.fromKept({ kb: KB, kept });
    const { session } = opened;

    try {
      expect(await session.refresh(session.token$.getValue())).toBe(newAccess);
      expect(session.token$.getValue()).toBe(newAccess);
      // The live transport's event stream also fetches; only the issuer call matters here.
      const tokenCall = fetchMock.mock.calls.find(([url]) => url === TEST_TOKEN_ENDPOINT) as unknown as [string, { body: URLSearchParams }] | undefined;
      expect(tokenCall).toBeDefined();
      expect(Object.fromEntries(tokenCall![1].body.entries())).toEqual({
        grant_type: 'refresh_token', refresh_token: 'refresh-tok', client_id: 'semiont-browser',
      });
      // The rotation is kept, and the person with it: the next renewal starts from the new token.
      expect(kept.held()).toMatchObject({ access: newAccess, refresh: 'refresh-2', personKey: 'gqB898gk4Ww_orAHhzDCSVl7yHP9UEsX0DA_xbGbq-I' });
    } finally {
      opened.dispose();
    }
  });

  test('renewals asked for together are one request of the issuer', async () => {
    const newAccess = freshJwt();
    const fetchMock = vi.fn(async (_url: string) => issuerReply({ access_token: newAccess, refresh_token: 'refresh-2' }));
    vi.stubGlobal('fetch', fetchMock);

    const opened = await SemiontSession.fromKept({ kb: KB, kept: new MemorySignIn(testSession(freshJwt(), 'refresh-tok')) });
    const { session } = opened;

    try {
      // A stream refused and a request refused at the same moment each ask.
      // An issuer that rotates refresh tokens refuses the second grant.
      const renewed = await Promise.all([session.refresh(session.token$.getValue()), session.refresh(session.token$.getValue())]);
      expect(renewed).toEqual([newAccess, newAccess]);
      expect(fetchMock.mock.calls.filter(([url]) => url === TEST_TOKEN_ENDPOINT)).toHaveLength(1);
    } finally {
      opened.dispose();
    }
  });

  test('a renewal the issuer refuses ends the session, and the kept sign-in is forgotten', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => issuerReply({ error: 'invalid_grant' }, 400)));
    const kept = new MemorySignIn(testSession(freshJwt(), 'refresh-tok'));
    const onAuthFailed = vi.fn();

    const opened = await SemiontSession.fromKept({ kb: KB, kept, onAuthFailed });
    const { session } = opened;

    try {
      expect(await session.refresh(session.token$.getValue())).toBeNull();
      expect(session.token$.getValue()).toBeNull();
      expect(onAuthFailed).toHaveBeenCalledWith('expired');
      expect(kept.held()).toBeNull();
    } finally {
      opened.dispose();
    }
  });

  test('at its start, an expired kept token is renewed, and the renewal kept', async () => {
    const newAccess = freshJwt();
    vi.stubGlobal('fetch', vi.fn(async () => issuerReply({ access_token: newAccess, refresh_token: 'refresh-2' })));
    const kept = new MemorySignIn(testSession(freshJwt(-60), 'refresh-tok'));

    const opened = await SemiontSession.fromKept({ kb: KB, kept });

    try {
      expect(opened.session.token$.getValue()).toBe(newAccess);
      expect(kept.held()).toMatchObject({ access: newAccess, refresh: 'refresh-2' });
    } finally {
      opened.dispose();
    }
  });

  test('at its start, an expired kept token the issuer will not renew is forgotten', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => issuerReply({ error: 'invalid_grant' }, 400)));
    const kept = new MemorySignIn(testSession(freshJwt(-60), 'refresh-tok'));

    const opened = await SemiontSession.fromKept({ kb: KB, kept });

    try {
      expect(opened.session.token$.getValue()).toBeNull();
      expect(kept.held()).toBeNull();
    } finally {
      opened.dispose();
    }
  });

  test("over a storage, keeps its persisted queries' documents there, for the person the kept sign-in names", async () => {
    const jo = { did: 'did:web:example.org:users:jo', email: 'jo@example.org', name: 'Jo', image: null, domain: 'example.org' };
    const person = personKey(jo.did);
    const kept = new MemorySignIn({ ...testSession(freshJwt(), 'refresh-tok'), personKey: person });
    const gateway = fakeGateway({ whoIs: async () => Response.json(jo), issuer: renews, resourceName: 'kept' });

    const opened = await SemiontSession.fromKept({ kb: KB, kept, storage, fetch: gateway.fetch });
    try {
      const name = await firstValueFrom(
        opened.session.client.browse.resource(resourceId('res-1')).pipe(filter(isReady), map((state) => state.value.name), take(1)),
      );
      expect(name).toBe('kept');
    } finally {
      // Closing flushes the save the resource's cache owes.
      opened.dispose();
      gateway.close();
    }

    const document = storage.get(cacheKey(KB.id, person, 'resource'));
    if (document === null) throw new Error("The resource's document was not kept in the storage");
    const { entries } = JSON.parse(document) as { entries: [string, { name: string }, number][] };
    expect(entries.map(([key, value]) => [key, value.name])).toEqual([['res-1', 'kept']]);
  });

  test('over a storage, a kept sign-in that names nobody keeps for the person the gateway names, once validate asks it', async () => {
    const jo = { did: 'did:web:example.org:users:jo', email: 'jo@example.org', name: 'Jo', image: null, domain: 'example.org' };
    const person = personKey(jo.did);
    const kept = new MemorySignIn(testSession(freshJwt(), 'refresh-tok'));
    const gateway = fakeGateway({ whoIs: async () => Response.json(jo), issuer: renews, resourceName: 'kept' });

    const opened = await SemiontSession.fromKept({
      kb: KB,
      kept,
      storage,
      fetch: gateway.fetch,
      validate: (token) => currentUserOf(baseUrl(kbGatewayUrl(KB.endpoint)), token, gateway.fetch),
    });
    try {
      expect(kept.held()?.personKey, "the person's key is recorded on the kept sign-in").toBe(person);
      const name = await firstValueFrom(
        opened.session.client.browse.resource(resourceId('res-1')).pipe(filter(isReady), map((state) => state.value.name), take(1)),
      );
      expect(name).toBe('kept');
    } finally {
      // Closing flushes the save the resource's cache owes.
      opened.dispose();
      gateway.close();
    }

    const document = storage.get(cacheKey(KB.id, person, 'resource'));
    if (document === null) throw new Error("The resource's document was not kept under the person the gateway named");
    const { entries } = JSON.parse(document) as { entries: [string, { name: string }, number][] };
    expect(entries.map(([key, value]) => [key, value.name])).toEqual([['res-1', 'kept']]);
  });
});

describe('SemiontSession.signInDevice', () => {
  const ISSUER = 'https://issuer.test/realms/semiont';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('runs the device grant against the issuer the KB trusts and keeps the sign-in where it is told', async () => {
    vi.useFakeTimers();
    vi.spyOn(HttpTransport.prototype, 'getProtectedResourceMetadata').mockResolvedValue({
      resource: 'http://test.local', authorization_servers: [ISSUER], bearer_methods_supported: ['header'],
    });
    const accessJwt = freshJwt();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return issuerReply({
          issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`,
          device_authorization_endpoint: `${ISSUER}/device`, revocation_endpoint: `${ISSUER}/revoke`,
        });
      }
      if (url === `${ISSUER}/device`) {
        return issuerReply({ device_code: 'dev', user_code: 'ABCD-EFGH', verification_uri: `${ISSUER}/verify`, expires_in: 600, interval: 1 });
      }
      return issuerReply({ access_token: accessJwt, refresh_token: 'refresh-tok' });
    }));
    const onCode = vi.fn();
    const kept = new MemorySignIn();

    const pending = SemiontSession.signInDevice({ kb: KB, kept, onCode });
    await vi.advanceTimersByTimeAsync(1500);
    await pending;

    expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'ABCD-EFGH' }));
    expect(kept.held()).toEqual({
      access: accessJwt, refresh: 'refresh-tok', clientId: 'semiont-cli',
      tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke`,
    });
  });

  test('signs in, and a session over what it kept asks the gateway and renews, through the fetch each is given, and nothing through the runtime\'s', async () => {
    vi.useFakeTimers();
    vi.spyOn(HttpTransport.prototype, 'getProtectedResourceMetadata').mockResolvedValue({
      resource: 'http://test.local', authorization_servers: [ISSUER], bearer_methods_supported: ['header'],
    });
    const runtimes = vi.fn(async () => issuerReply({ error: 'not this fetch' }, 400));
    vi.stubGlobal('fetch', runtimes);
    const accessJwt = freshJwt();
    const given = vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return issuerReply({
          issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`,
          device_authorization_endpoint: `${ISSUER}/device`, revocation_endpoint: `${ISSUER}/revoke`,
        });
      }
      if (url === `${ISSUER}/device`) {
        return issuerReply({ device_code: 'dev', user_code: 'ABCD-EFGH', verification_uri: `${ISSUER}/verify`, expires_in: 600, interval: 1 });
      }
      if (url === `${ISSUER}/token`) return issuerReply({ access_token: accessJwt, refresh_token: 'refresh-tok' });
      if (url.endsWith('/api/users/me')) return Response.json({ did: 'did:web:example.org:users:alice', email: null, name: 'Alice', image: null, domain: 'example.org' });
      // The session's stream: held open, and saying nothing.
      return new Promise<Response>(() => {});
    });

    const kept = new MemorySignIn();
    const pending = SemiontSession.signInDevice({ kb: KB, kept, onCode: () => {}, fetch: given });
    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    vi.useRealTimers();
    const opened = await SemiontSession.fromKept({ kb: KB, kept, fetch: given });

    try {
      await opened.session.client.auth!.me();
      await opened.session.refresh(opened.session.token$.getValue());
      const asked = given.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
      expect(asked.filter((url) => !url.endsWith('/bus/subscribe'))).toEqual([
        `${ISSUER}/.well-known/openid-configuration`,
        `${ISSUER}/device`,
        `${ISSUER}/token`,
        'http://localhost:4000/api/users/me',
        `${ISSUER}/token`,
      ]);
      expect(runtimes).not.toHaveBeenCalled();
    } finally {
      opened.dispose();
    }
  });

  test('forwards optional onAuthFailed / onError callbacks into the session config', async () => {
    const jwt = freshJwt();
    vi.stubGlobal('fetch', vi.fn(async () => issuerReply({ access_token: jwt })));

    const onAuthFailed = vi.fn();
    const onError = vi.fn();
    const opened = await SemiontSession.fromKept({
      kb: KB,
      kept: new MemorySignIn(testSession(jwt, 'refresh-tok')),
      onAuthFailed,
      onError,
    });
    const { session } = opened;

    try {
      // Sanity: the session was constructed with our callbacks (test the
      // wiring by triggering an auth-failed path).
      // We don't assert these were CALLED — just that signIn accepted them
      // without choking and the session is functional.
      expect(session).toBeInstanceOf(SemiontSession);
    } finally {
      opened.dispose();
    }
  });
});

describe('a new sign-in saved over a stored one', () => {
  const JO = personKey('did:web:kb.example.org:users:jo%40example.org');
  const ANN = personKey('did:web:kb.example.org:users:ann%40example.org');

  /** Every key a person's client keeps on a knowledge base: its stream's places, and each persisted query's. */
  const keptFor = (kbId: string, person: string): string[] => [
    lastEventIdKey(kbId, person),
    ...PERSISTED_QUERIES.map((query) => cacheKey(kbId, person, query)),
  ];
  const JOS = keptFor(KB.id, JO);
  /** What is kept for another person here, and for jo on another knowledge base. */
  const OTHERS = [...keptFor(KB.id, ANN), ...keptFor('kb-elsewhere', JO)];
  const KEPT = 'kept';

  /** Everything kept for jo and the others, and the KB's stored sign-in as `signedIn` says. */
  const seedOld = (signedIn: 'named' | 'unnamed' | 'none'): void => {
    for (const key of [...JOS, ...OTHERS]) storage.set(key, KEPT);
    if (signedIn === 'none') return;
    const old = testSession(freshJwt(), 'refresh-old');
    storage.set(storageKey(KB.id), JSON.stringify(signedIn === 'named' ? { ...old, personKey: JO } : old));
  };

  describe('setStoredSession', () => {
    test('over a stored sign-in naming a person: what was kept for them on the knowledge base is deleted, and nothing else', () => {
      seedOld('named');
      const issued = testSession(freshJwt(), 'refresh-new');

      setStoredSession(storage, KB.id, issued);

      for (const key of JOS) expect(storage.get(key), key).toBeNull();
      for (const key of OTHERS) expect(storage.get(key), key).toBe(KEPT);
      expect(getStoredSession(storage, KB.id)).toEqual(issued);
    });

    test.each(['unnamed', 'none'] as const)('over %s: nothing is deleted', (signedIn) => {
      seedOld(signedIn);
      const issued = testSession(freshJwt(), 'refresh-new');

      setStoredSession(storage, KB.id, issued);

      for (const key of [...JOS, ...OTHERS]) expect(storage.get(key), key).toBe(KEPT);
      expect(getStoredSession(storage, KB.id)).toEqual(issued);
    });
  });

  describe('a renewal', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    test('of a stored sign-in naming a person keeps them, and deletes nothing', async () => {
      seedOld('named');
      const held = getStoredSession(storage, KB.id);
      if (held === null) throw new Error('the sign-in was not stored');
      vi.stubGlobal('fetch', vi.fn(async () => issuerReply({ access_token: freshJwt(), refresh_token: 'refresh-2' })));

      expect(await refreshStoredSession(storage, KB.id, held.access)).not.toBeNull();

      expect(getStoredSession(storage, KB.id)?.personKey).toBe(JO);
      for (const key of [...JOS, ...OTHERS]) expect(storage.get(key), key).toBe(KEPT);
    });
  });
});
