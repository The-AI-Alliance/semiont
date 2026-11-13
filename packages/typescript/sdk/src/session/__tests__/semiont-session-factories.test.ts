/**
 * Tests for the `SemiontSession` factories: `fromHttp` (structural — brand
 * the inputs, build the transport stack, thread the shared `token$`),
 * `fromKept` (a sign-in kept where its holder keeps it: renewed and
 * forgotten there, and the ready session given), and `signInDevice` (the
 * device grant end to end, the sign-in kept where it is told, and a session
 * then built over it). `fromHttp` and `fromKept` each give an
 * `OpenedSession`: the session and the client it was built with, ended
 * together, the client first. What a session says went wrong, it says on its
 * errors stream, beside its transport's failures: it takes no callback for
 * them. A session over a kept sign-in asks the gateway who its token is
 * unless it is told not to. They
 * construct a real `SemiontClient` over a real
 * `HttpTransport`, so the wire is kept quiet by spying on the transport and
 * stubbing `fetch` for the issuer. And a new sign-in saved over a stored one
 * by `setStoredSession` forgets it, with what was kept for the person it
 * named; a renewal forgets nothing.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { filter, firstValueFrom, map, take } from 'rxjs';
import { HttpTransport } from '@semiont/http-transport';
import { PERSISTED_QUERIES, resourceId } from '@semiont/core';

import { isReady } from '../../cache';
import { renewKept } from '../../index';
import { SemiontSession } from '../semiont-session';
import { MemorySignIn } from '../sign-in-kept';
import { cacheKey, getStoredSession, kbGatewayUrl, keptIn, lastEventIdKey, personKey, setStoredSession } from '../storage';
import { fakeGateway, refuses, renews } from './fake-gateway';
import { RefusingStorage, TestStorage, UNREADABLE, UnreadableSignIn, freshJwt, storageKey, testSession, TEST_TOKEN_ENDPOINT } from './test-storage-helpers';

const KB = {
  id: 'kb-factory',
  label: 'Factory KB',
  did: 'did:web:example.github.io:test-kb',
  endpoint: { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const },
};

let storage: TestStorage;

/** Where `saidBy` marks the end of a session's errors stream. */
const ENDED = 'the stream ended';

/** The code of each error `session` says on its errors stream from now on, and `ENDED` once the stream ends. */
function saidBy(session: SemiontSession): string[] {
  const said: string[] = [];
  session.errors$.subscribe({ next: (error) => said.push(error.code), complete: () => said.push(ENDED) });
  return said;
}

/** The name of the resource `id`, as `session`'s client reads it. */
const nameOf = (session: SemiontSession, id: string): Promise<string> =>
  firstValueFrom(session.client.browse.resource(resourceId(id)).pipe(filter(isReady), map((state) => state.value.name), take(1)));

const JO = { did: 'did:web:example.org:users:jo', email: 'jo@example.org', name: 'Jo', image: null, domain: 'example.org' };

beforeEach(() => {
  storage = new TestStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SemiontSession.fromHttp', () => {
  test('what it gives closes the client it was built with, then ends the session', async () => {
    const opened = SemiontSession.fromHttp({ kb: KB, kept: new MemorySignIn(), baseUrl: 'http://test.local' });
    await opened.session.ready;
    const { client } = opened.session;
    const close = client.dispose.bind(client);
    const ended: string[] = [];
    const closed = vi.spyOn(client, 'dispose').mockImplementation(() => {
      ended.push('client');
      close();
    });
    opened.session.token$.subscribe({ complete: () => ended.push('session') });

    opened.dispose();

    // The client's closing flush says what it says on the session's errors before they end.
    expect(ended).toEqual(['client', 'session']);
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

  test('renews a refused token before retrying the request', async () => {
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
      requests.push(token);
      if (token === 'old-token') return new Response(null, { status: 401 });
      return Response.json({
        did: 'did:web:example.org:users:alice',
        email: 'alice@example.org',
        name: 'Alice',
        image: null,
        domain: 'example.org',
      });
    });
    const refresh = vi.fn(async () => 'new-token');
    const opened = SemiontSession.fromHttp({
      kb: KB,
      kept: new MemorySignIn(),
      baseUrl: 'http://test.local',
      token: 'old-token',
      fetch: fetch as typeof globalThis.fetch,
      refresh,
    });

    try {
      await opened.session.ready;
      await expect(opened.session.client.auth!.me()).resolves.toMatchObject({ name: 'Alice' });
      expect(requests).toEqual(['old-token', 'new-token']);
      expect(refresh).toHaveBeenCalledOnce();
      expect(opened.session.token$.getValue()).toBe('new-token');
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

  test('says on one errors stream what its transport failed at and what went wrong with its sign-in, each once, until it ends', async () => {
    const token = freshJwt();
    const gateway = fakeGateway({ whoIs: async () => new Response(null, { status: 403 }), issuer: renews, resourceName: 'any' });
    const opened = SemiontSession.fromHttp({
      kb: KB,
      kept: new MemorySignIn(testSession(token, 'refresh-tok')),
      baseUrl: kbGatewayUrl(KB.endpoint),
      token,
      fetch: gateway.fetch,
      // A renewal that got no answer: what is kept stays, and the session says why.
      refresh: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const said = saidBy(opened.session);
    try {
      await opened.session.ready;
      await expect(opened.session.client.auth!.me()).rejects.toMatchObject({ code: 'forbidden' });
      await expect(opened.session.refresh(token)).resolves.toBeNull();
    } finally {
      opened.dispose();
      gateway.close();
    }

    expect(said).toEqual(['forbidden', 'session.refresh-exhausted', ENDED]);
  });
});

function issuerReply(json: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => json } as unknown as Response;
}

/**
 * The runtime's `fetch` as a test stubs it: the gateway says who a token is,
 * jo, and `issuer` answers every other request.
 */
const gatewayOr = (issuer: () => Response) => async (input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
  ((input instanceof Request ? input.url : String(input)).endsWith('/api/users/me') ? Response.json(JO) : issuer());

/** A sign-in kept in memory on which no person can be recorded: recording one throws. */
class UnrecordableSignIn extends MemorySignIn {
  override recordPersonKey(): boolean {
    throw new Error('the person could not be recorded on the kept sign-in');
  }
}

describe('SemiontSession.fromKept', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('starts with the access token the kept sign-in holds, and is ready', async () => {
    const accessJwt = freshJwt();
    const kept = new MemorySignIn(testSession(accessJwt, 'refresh-tok'));
    const gateway = fakeGateway({ whoIs: async () => Response.json(JO), issuer: renews, resourceName: 'kept' });

    const opened = await SemiontSession.fromKept({ kb: KB, kept, fetch: gateway.fetch });

    try {
      expect(opened.session.token$.getValue()).toBe(accessJwt);
      expect(kept.held()).toEqual(testSession(accessJwt, 'refresh-tok'));
    } finally {
      opened.dispose();
      gateway.close();
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
    const fetchMock = vi.fn(gatewayOr(() => issuerReply({ access_token: newAccess, refresh_token: 'refresh-2' })));
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
    const fetchMock = vi.fn(gatewayOr(() => issuerReply({ access_token: newAccess, refresh_token: 'refresh-2' })));
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
    vi.stubGlobal('fetch', vi.fn(gatewayOr(() => issuerReply({ error: 'invalid_grant' }, 400))));
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
    vi.stubGlobal('fetch', vi.fn(gatewayOr(() => issuerReply({ access_token: newAccess, refresh_token: 'refresh-2' }))));
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

    const opened = await SemiontSession.fromKept({ kb: KB, kept, storage, fetch: gateway.fetch, validate: true });
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

  test('with validate, asks the gateway who the kept token is, through the fetch it is given, and is ready knowing who', async () => {
    const runtimes = vi.fn(async () => issuerReply({ error: 'not this fetch' }, 400));
    vi.stubGlobal('fetch', runtimes);
    let asked = 0;
    const gateway = fakeGateway({
      whoIs: async () => {
        asked += 1;
        return Response.json(JO);
      },
      issuer: renews,
      resourceName: 'kept',
    });

    const opened = await SemiontSession.fromKept({
      kb: KB,
      kept: new MemorySignIn(testSession(freshJwt(), 'refresh-tok')),
      fetch: gateway.fetch,
      validate: true,
    });
    try {
      expect(asked).toBe(1);
      expect(opened.session.user$.getValue()).toMatchObject({ did: JO.did, name: 'Jo' });
      expect(runtimes).not.toHaveBeenCalled();
    } finally {
      opened.dispose();
      gateway.close();
    }
  });

  test('with validate false, asks the gateway nothing, and nobody is known', async () => {
    let asked = 0;
    const gateway = fakeGateway({
      whoIs: async () => {
        asked += 1;
        return Response.json(JO);
      },
      issuer: renews,
      resourceName: 'kept',
    });

    const opened = await SemiontSession.fromKept({
      kb: KB,
      kept: new MemorySignIn(testSession(freshJwt(), 'refresh-tok')),
      fetch: gateway.fetch,
      validate: false,
    });
    try {
      expect(asked).toBe(0);
      expect(opened.session.user$.getValue()).toBeNull();
    } finally {
      opened.dispose();
      gateway.close();
    }
  });

  test('leaving validate out, asks the gateway who the kept token is, once, and is ready knowing who', async () => {
    let asked = 0;
    const gateway = fakeGateway({
      whoIs: async () => {
        asked += 1;
        return Response.json(JO);
      },
      issuer: renews,
      resourceName: 'kept',
    });

    const opened = await SemiontSession.fromKept({
      kb: KB,
      kept: new MemorySignIn(testSession(freshJwt(), 'refresh-tok')),
      fetch: gateway.fetch,
    });
    try {
      expect(asked).toBe(1);
      expect(opened.session.user$.getValue()).toMatchObject({ did: JO.did, name: 'Jo' });
    } finally {
      opened.dispose();
      gateway.close();
    }
  });

  test('says a renewal the issuer refuses on its errors stream, once, and tells onAuthFailed why it ended', async () => {
    const gateway = fakeGateway({ whoIs: async () => Response.json(JO), issuer: refuses, resourceName: 'kept' });
    const onAuthFailed = vi.fn();
    const opened = await SemiontSession.fromKept({
      kb: KB,
      kept: new MemorySignIn(testSession(freshJwt(), 'refresh-tok')),
      fetch: gateway.fetch,
      onAuthFailed,
    });
    const said = saidBy(opened.session);
    try {
      expect(await opened.session.refresh(opened.session.token$.getValue())).toBeNull();
      expect(onAuthFailed).toHaveBeenCalledWith('expired');
    } finally {
      opened.dispose();
      gateway.close();
    }

    expect(said).toEqual(['session.refresh-exhausted', ENDED]);
  });

  test.each([
    { where: 'without a storage', withStorage: false },
    { where: 'over a storage', withStorage: true },
  ])('a kept sign-in that cannot be read as the session starts gives its caller why, and no session ($where)', async ({ withStorage }) => {
    const kept = new UnreadableSignIn(testSession(freshJwt(), 'refresh-tok'));
    kept.unreadable = true;

    await expect(SemiontSession.fromKept({ kb: KB, kept, ...(withStorage ? { storage } : {}) })).rejects.toThrow(UNREADABLE);
  });

  test("over a storage, a kept sign-in that cannot be read before a save says session.keep-failed once on the session's errors, and the client keeps nothing more", async () => {
    const person = personKey(JO.did);
    const kept = new UnreadableSignIn({ ...testSession(freshJwt(), 'refresh-tok'), personKey: person });
    const gateway = fakeGateway({ whoIs: async () => Response.json(JO), issuer: renews, resourceName: 'kept' });
    const opened = await SemiontSession.fromKept({ kb: KB, kept, storage, fetch: gateway.fetch });
    const said = saidBy(opened.session);
    try {
      kept.unreadable = true;
      expect(await nameOf(opened.session, 'res-1')).toBe('kept');
      // Its save finds the sign-in unreadable.
      await vi.waitFor(() => expect(kept.failedReads).toBeGreaterThan(0));
      // Readable again, and naming jo still: the client writes nothing all the same, closing included.
      kept.unreadable = false;
      expect(await nameOf(opened.session, 'res-2')).toBe('kept');
    } finally {
      opened.dispose();
      gateway.close();
    }

    expect(storage.get(cacheKey(KB.id, person, 'resource'))).toBeNull();
    expect(said).toEqual(['session.keep-failed', ENDED]);
  });

  test("over a storage, a closing save that cannot read the kept sign-in says one session.keep-failed on the session's errors, and the stream then ends", async () => {
    const person = personKey(JO.did);
    const kept = new UnreadableSignIn({ ...testSession(freshJwt(), 'refresh-tok'), personKey: person });
    const gateway = fakeGateway({ whoIs: async () => Response.json(JO), issuer: renews, resourceName: 'kept' });
    const opened = await SemiontSession.fromKept({ kb: KB, kept, storage, fetch: gateway.fetch });
    const said = saidBy(opened.session);
    try {
      // A value the client holds, whose save it owes as it closes: well inside the save's debounce.
      expect(await nameOf(opened.session, 'res-1')).toBe('kept');
      kept.unreadable = true;
    } finally {
      opened.dispose();
      gateway.close();
    }

    // The closing save read the sign-in, and could not.
    expect(kept.failedReads).toBeGreaterThan(0);
    expect(storage.get(cacheKey(KB.id, person, 'resource'))).toBeNull();
    expect(said).toEqual(['session.keep-failed', ENDED]);
  });

  test("over a storage, a write the storage refuses says one session.save-refused on the session's errors, with what the storage said, and the save stays owed: the closing makes it", async () => {
    const person = personKey(JO.did);
    const resource = cacheKey(KB.id, person, 'resource');
    let refuses = false;
    const refusing = new RefusingStorage((key) => refuses && key === resource);
    const kept = new MemorySignIn({ ...testSession(freshJwt(), 'refresh-tok'), personKey: person });
    const gateway = fakeGateway({ whoIs: async () => Response.json(JO), issuer: renews, resourceName: 'kept' });
    const opened = await SemiontSession.fromKept({ kb: KB, kept, storage: refusing, fetch: gateway.fetch });
    const said = saidBy(opened.session);
    const words: string[] = [];
    opened.session.errors$.subscribe((error) => words.push(error.message));
    try {
      refuses = true;
      expect(await nameOf(opened.session, 'res-1')).toBe('kept');
      // Its save, past the debounce, is refused, and said as it is.
      await vi.waitFor(() => expect(refusing.refusals).toBe(1));
      expect(said).toEqual(['session.save-refused']);
      expect(words[0]).toContain(`refused: ${resource}`);
      // The storage takes writes again, and nothing has asked for one since.
      refuses = false;
    } finally {
      opened.dispose();
      gateway.close();
    }

    // The save was still owed, and the closing made it.
    expect(refusing.refusals).toBe(1);
    expect(refusing.get(resource)).not.toBeNull();
    expect(said).toEqual(['session.save-refused', ENDED]);
  });

  test("over a storage, a closing write the storage still refuses says one more session.save-refused on the session's errors, and the stream then ends", async () => {
    const person = personKey(JO.did);
    const resource = cacheKey(KB.id, person, 'resource');
    let refuses = false;
    const refusing = new RefusingStorage((key) => refuses && key === resource);
    const kept = new MemorySignIn({ ...testSession(freshJwt(), 'refresh-tok'), personKey: person });
    const gateway = fakeGateway({ whoIs: async () => Response.json(JO), issuer: renews, resourceName: 'kept' });
    const opened = await SemiontSession.fromKept({ kb: KB, kept, storage: refusing, fetch: gateway.fetch });
    const said = saidBy(opened.session);
    try {
      refuses = true;
      expect(await nameOf(opened.session, 'res-1')).toBe('kept');
      await vi.waitFor(() => expect(refusing.refusals).toBe(1));
      expect(said).toEqual(['session.save-refused']);
    } finally {
      // The storage refuses the closing's write too.
      opened.dispose();
      gateway.close();
    }

    // What the closing could not write is lost.
    expect(refusing.refusals).toBe(2);
    expect(refusing.get(resource)).toBeNull();
    expect(said).toEqual(['session.save-refused', 'session.save-refused', ENDED]);
  });

  test("over a storage, a sign-in that cannot record the person the gateway named says session.keep-failed once on the session's errors, keeps nothing, and the session goes on", async () => {
    const person = personKey(JO.did);
    const kept = new UnrecordableSignIn(testSession(freshJwt(), 'refresh-tok'));
    let reachable = false;
    const gateway = fakeGateway({
      whoIs: async () => {
        if (!reachable) throw new TypeError('fetch failed');
        return Response.json(JO);
      },
      issuer: renews,
      resourceName: 'fresh',
    });
    const opened = await SemiontSession.fromKept({ kb: KB, kept, storage, fetch: gateway.fetch, validate: true });
    const said = saidBy(opened.session);
    // What the start said, it said before its caller could read the stream: whether the stream holds it is not this test's.
    const saidAtStart = said.length;
    try {
      // The start could not ask who the token is. A refusal renews it, and the gateway is asked who the renewed one is: jo.
      reachable = true;
      await opened.session.refresh(opened.session.token$.getValue());
      expect(opened.session.user$.getValue()).toMatchObject({ did: JO.did });
      expect(await nameOf(opened.session, 'res-1')).toBe('fresh');
    } finally {
      opened.dispose();
      gateway.close();
    }

    expect(kept.held()?.personKey).toBeUndefined();
    expect(storage.get(cacheKey(KB.id, person, 'resource'))).toBeNull();
    expect(said.slice(saidAtStart)).toEqual(['session.keep-failed', ENDED]);
  });

  test("over a storage, a sign-in that names its person but cannot record the person the gateway named says session.keep-failed once, the client keeping from the start writes nothing more, and the session goes on", async () => {
    const person = personKey(JO.did);
    const kept = new UnrecordableSignIn({ ...testSession(freshJwt(), 'refresh-tok'), personKey: person });
    const gateway = fakeGateway({ whoIs: async () => Response.json(JO), issuer: renews, resourceName: 'fresh' });
    const opened = await SemiontSession.fromKept({ kb: KB, kept, storage, fetch: gateway.fetch });
    // Its first reader: what the start said is kept for it.
    const said = saidBy(opened.session);
    try {
      expect(opened.session.user$.getValue()).toMatchObject({ did: JO.did });
      expect(opened.session.token$.getValue()).not.toBeNull();
      // A value whose save, past the debounce and at the closing, would be written while the client kept.
      expect(await nameOf(opened.session, 'res-1')).toBe('fresh');
    } finally {
      opened.dispose();
      gateway.close();
    }

    expect(kept.held()?.personKey).toBe(person);
    for (const key of [lastEventIdKey(KB.id, person), ...PERSISTED_QUERIES.map((query) => cacheKey(KB.id, person, query))]) {
      expect(storage.get(key), key).toBeNull();
    }
    expect(said).toEqual(['session.keep-failed', ENDED]);
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
        // The session's start asks who the kept token is.
        'http://localhost:4000/api/users/me',
        // The client's request.
        'http://localhost:4000/api/users/me',
        `${ISSUER}/token`,
        // Who the renewed token is.
        'http://localhost:4000/api/users/me',
      ]);
      expect(runtimes).not.toHaveBeenCalled();
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

      expect(await renewKept(keptIn(storage, KB.id), held.access)).not.toBeNull();

      expect(getStoredSession(storage, KB.id)?.personKey).toBe(JO);
      for (const key of [...JOS, ...OTHERS]) expect(storage.get(key), key).toBe(KEPT);
    });
  });
});
