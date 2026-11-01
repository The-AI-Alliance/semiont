/**
 * The session layer as an OAuth public client: issuer discovery from a KB's
 * resource metadata, the authorization-code grant with PKCE, the device
 * grant, refresh, and revocation — against a fetch stub, with the issuer's
 * answers scripted per case. Nothing here names a vendor.
 */
import util from 'node:util';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HTTP_REQUEST_TIMEOUT_MS, REFRESH_RETRY, SignInError } from '@semiont/core';
import { APIError, HttpTransport } from '@semiont/http-transport';
import { InMemorySessionStorage } from '../session-storage';
import {
  BROWSER_CLIENT_ID,
  PENDING_AUTHORIZATION_KEY,
  SCRIPT_CLIENT_ID,
  beginAuthorization,
  codeChallenge,
  completeAuthorization,
  discoverIssuer,
  refreshAtIssuer,
  refreshStoredSession,
  revokeAtIssuer,
  signInWithDeviceGrant,
} from '../oauth';

const TARGET = { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const };
const ISSUER = 'https://issuer.test/realms/semiont';
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  device_authorization_endpoint: `${ISSUER}/device`,
  revocation_endpoint: `${ISSUER}/revoke`,
};
const REDIRECT = 'http://localhost:3000/en/auth/callback';

function reply(json: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => {
      // What the runtime says of a body that is no JSON: an answer with no body is one.
      if (json === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return json;
    },
  } as unknown as Response;
}

const UNREAD = 'what-the-runtime-could-not-read';
/**
 * What Node's `fetch` rejects with when an answer is not HTTP, and what a
 * body's read rejects with when the body is not: what the runtime could not
 * read rides on the cause. Core's own suite sees the runtime make one; here
 * it is made by hand, for requests that are stubbed.
 */
function unread(said: 'fetch failed' | 'terminated' = 'fetch failed'): TypeError {
  const cause = Object.assign(new Error('Response does not match the HTTP/1.1 protocol (Invalid header token)'), { name: 'HTTPParserError', data: UNREAD });
  return new TypeError(said, { cause });
}

/** What is printed of a failure wherever it is logged whole. */
const printed = (failure: unknown): string => util.inspect(failure, { depth: 6 });

/** The form a POST carried, decoded. */
function formOf(call: unknown[]): Record<string, string> {
  const init = call[1] as { body: URLSearchParams };
  return Object.fromEntries(init.body.entries());
}

let fetchMock: ReturnType<typeof vi.fn>;
let metadata: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  metadata = vi.spyOn(HttpTransport.prototype, 'getProtectedResourceMetadata').mockResolvedValue({
    resource: 'http://localhost:4000',
    authorization_servers: [ISSUER],
    bearer_methods_supported: ['header'],
  });
  fetchMock = vi.fn(async (url: string) =>
    url.endsWith('/.well-known/openid-configuration') ? reply(DISCOVERY) : reply(undefined, 404));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PKCE', () => {
  it('derives the S256 challenge of RFC 7636 appendix B', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

// A page served over plain http from any host but localhost is not a secure
// context: the browser gives it `crypto.getRandomValues` and withholds
// `crypto.subtle`. The launcher registers such an origin (the host's LAN
// address), so a sign-in has to work there. These run under exactly that
// environment: a `crypto` global with `getRandomValues` and nothing else.
describe('PKCE in an insecure browsing context (no crypto.subtle)', () => {
  beforeEach(() => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
  });

  it('the stub reproduces the broken environment', () => {
    expect(crypto.getRandomValues).toBeTypeOf('function');
    expect((crypto as { subtle?: unknown }).subtle).toBeUndefined();
  });

  it('derives the same challenge of RFC 7636 appendix B', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('begins a sign-in: the authorization URL carries the challenge of the verifier it remembered', async () => {
    const storage = new InMemorySessionStorage();

    const url = new URL(await beginAuthorization({ target: TARGET, redirectUri: REDIRECT }, storage));

    const record = JSON.parse(storage.get(PENDING_AUTHORIZATION_KEY)!) as { verifier: string };
    // 48 random bytes: the 64 characters production hashes, and no other length.
    expect(record.verifier).toHaveLength(64);
    expect(url.searchParams.get('code_challenge')).toBe(codeChallenge(record.verifier));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('discoverIssuer', () => {
  it('follows the resource metadata to the issuer, then discovery to its endpoints', async () => {
    const endpoints = await discoverIssuer(TARGET);

    expect(endpoints).toEqual({
      issuer: ISSUER,
      authorization: `${ISSUER}/auth`,
      token: `${ISSUER}/token`,
      device: `${ISSUER}/device`,
      revocation: `${ISSUER}/revoke`,
    });
    expect(fetchMock).toHaveBeenCalledWith(`${ISSUER}/.well-known/openid-configuration`, expect.anything());
  });

  it('asks the knowledge base and its issuer through the fetch it is given, and nothing through the runtime\'s', async () => {
    metadata.mockRestore();
    const given = vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: 'http://localhost:4000', authorization_servers: [ISSUER], bearer_methods_supported: ['header'] });
      }
      return url.endsWith('/.well-known/openid-configuration') ? Response.json(DISCOVERY) : new Response(null, { status: 404 });
    });

    await expect(discoverIssuer(TARGET, given)).resolves.toMatchObject({ issuer: ISSUER, token: `${ISSUER}/token` });

    expect(given.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)))).toEqual([
      'http://localhost:4000/.well-known/oauth-protected-resource',
      `${ISSUER}/.well-known/openid-configuration`,
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names a KB that trusts no issuer', async () => {
    metadata.mockRejectedValue(APIError.fromStatus('Not Found', 404, 'Not Found', undefined, undefined));

    await expect(discoverIssuer(TARGET)).rejects.toMatchObject({ code: 'no-issuer' });
  });

  it('refuses a discovery document that names a different issuer', async () => {
    fetchMock.mockImplementation(async () => reply({ ...DISCOVERY, issuer: 'https://other.test' }));

    await expect(discoverIssuer(TARGET)).rejects.toMatchObject({ code: 'discovery' });
  });

  it('an issuer that does not answer its discovery is said by the kind of error, with no status and nothing of the answer', async () => {
    fetchMock.mockRejectedValue(unread());

    const failure: unknown = await discoverIssuer(TARGET).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SignInError);
    expect(failure).toMatchObject({ code: 'discovery', message: `Issuer ${ISSUER}: discovery was not answered: HTTPParserError`, status: undefined });
    expect(printed(failure)).not.toContain(UNREAD);
  });

  it('a discovery document that stops coming is a discovery that was not answered', async () => {
    const stopped = new ReadableStream<Uint8Array>({ start: (body) => body.error(unread('terminated')) });
    fetchMock.mockImplementation(async () => new Response(stopped));

    const failure: unknown = await discoverIssuer(TARGET).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: 'discovery', message: `Issuer ${ISSUER}: discovery was not answered: HTTPParserError`, status: undefined });
    expect(printed(failure)).not.toContain(UNREAD);
  });

  it('a discovery document that is not JSON is no OpenID configuration, and none of it is said', async () => {
    // Whatever parses a body says where it stopped, and quotes the body there.
    fetchMock.mockImplementation(async () => new Response(`{"issuer": ${UNREAD}}`));

    const failure: unknown = await discoverIssuer(TARGET).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: 'discovery', message: `Issuer ${ISSUER}: its discovery document is not an OpenID configuration for it` });
    expect(printed(failure)).not.toContain(UNREAD.slice(0, 6));
  });
});

describe('the authorization-code grant', () => {
  it('remembers the pending sign-in and builds the authorization URL around it', async () => {
    const pending = new InMemorySessionStorage();

    const url = new URL(await beginAuthorization({
      target: TARGET, redirectUri: REDIRECT, expectedDid: 'did:web:kb.example', expectedName: 'KB',
    }, pending));

    const record = JSON.parse(pending.get(PENDING_AUTHORIZATION_KEY)!);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/auth`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(BROWSER_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(record.state);
    expect(url.searchParams.get('code_challenge')).toBe(codeChallenge(record.verifier));
    expect(record).toMatchObject({ target: TARGET, redirectUri: REDIRECT, expectedDid: 'did:web:kb.example', expectedName: 'KB' });
    expect(record.issuer.token).toBe(`${ISSUER}/token`);
  });

  async function begun() {
    const pending = new InMemorySessionStorage();
    await beginAuthorization({ target: TARGET, redirectUri: REDIRECT, kbId: 'kb-1' }, pending);
    const record = JSON.parse(pending.get(PENDING_AUTHORIZATION_KEY)!);
    return { pending, state: record.state as string, verifier: record.verifier as string };
  }

  it('exchanges the code with the verifier, and consumes the pending record', async () => {
    const { pending, state, verifier } = await begun();
    fetchMock.mockImplementation(async () => reply({ access_token: 'acc', refresh_token: 'ref', token_type: 'Bearer' }));

    const result = await completeAuthorization(`${REDIRECT}?code=the-code&state=${state}`, pending);

    expect(result.tokens).toEqual({ access: 'acc', refresh: 'ref' });
    expect(result.pending.kbId).toBe('kb-1');
    const tokenCall = fetchMock.mock.calls.find(([url]) => url === `${ISSUER}/token`);
    expect(tokenCall).toBeDefined();
    expect(formOf(tokenCall!)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT,
      client_id: BROWSER_CLIENT_ID,
      code_verifier: verifier,
    });
    // One-shot: the same callback cannot be completed twice.
    await expect(completeAuthorization(`${REDIRECT}?code=the-code&state=${state}`, pending))
      .rejects.toMatchObject({ code: 'no-pending' });
  });

  it('refuses a response whose state is not the pending one', async () => {
    const { pending } = await begun();

    await expect(completeAuthorization(`${REDIRECT}?code=c&state=forged`, pending))
      .rejects.toMatchObject({ code: 'state' });
    expect(fetchMock.mock.calls.some(([url]) => url === `${ISSUER}/token`)).toBe(false);
  });

  it('reports a denial at the issuer as a denial', async () => {
    const { pending, state } = await begun();

    await expect(completeAuthorization(`${REDIRECT}?error=access_denied&state=${state}`, pending))
      .rejects.toMatchObject({ code: 'denied' });
  });

  it('refuses tokens without a refresh token — the session could not outlive them', async () => {
    const { pending, state } = await begun();
    fetchMock.mockImplementation(async () => reply({ access_token: 'acc', token_type: 'Bearer' }));

    await expect(completeAuthorization(`${REDIRECT}?code=c&state=${state}`, pending))
      .rejects.toMatchObject({ code: 'exchange' });
  });
});

describe('refresh and revocation', () => {
  it('keeps the held refresh token when the issuer does not rotate it', async () => {
    fetchMock.mockImplementation(async () => reply({ access_token: 'acc-2', token_type: 'Bearer' }));

    const tokens = await refreshAtIssuer(`${ISSUER}/token`, BROWSER_CLIENT_ID, 'ref-1');

    expect(tokens).toEqual({ access: 'acc-2', refresh: 'ref-1' });
    expect(formOf(fetchMock.mock.calls[0]!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'ref-1', client_id: BROWSER_CLIENT_ID });
  });

  it('asks the issuer through the fetch it is given, and nothing through the runtime\'s', async () => {
    const given = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => reply({ access_token: 'acc-2' }));

    expect(await refreshAtIssuer(`${ISSUER}/token`, BROWSER_CLIENT_ID, 'ref-1', given)).toEqual({ access: 'acc-2', refresh: 'ref-1' });

    expect(given.mock.calls.map(([input]) => input)).toEqual([`${ISSUER}/token`]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes a rotated refresh token', async () => {
    fetchMock.mockImplementation(async () => reply({ access_token: 'acc-2', refresh_token: 'ref-2' }));

    expect(await refreshAtIssuer(`${ISSUER}/token`, BROWSER_CLIENT_ID, 'ref-1')).toEqual({ access: 'acc-2', refresh: 'ref-2' });
  });

  it('surfaces the issuer refusal', async () => {
    fetchMock.mockImplementation(async () => reply({ error: 'invalid_grant', error_description: 'revoked' }, 400));

    await expect(refreshAtIssuer(`${ISSUER}/token`, BROWSER_CLIENT_ID, 'ref-1'))
      .rejects.toThrow(/invalid_grant: revoked/);
  });

  // ── A refusal is terminal; an outage is retried ──────────────────────
  // `refreshStoredSession` answered `null` for every failure, and its caller
  // treats `null` as terminal — so a lost packet ended the session exactly
  // like a revocation. The issuer's answer is the verdict; its absence is not.
  //
  // The retry lives HERE and not in the session on purpose: retry belongs in
  // the callback, which owns the HTTP call.

  describe('refreshStoredSession separates a refusal from an outage', () => {
    const KB = 'kb-alpha';

    function seeded() {
      const storage = new InMemorySessionStorage();
      storage.set(`semiont.session.${KB}`, JSON.stringify({
        access: 'acc-1',
        refresh: 'ref-1',
        clientId: BROWSER_CLIENT_ID,
        tokenEndpoint: `${ISSUER}/token`,
        issuer: ISSUER,
      }));
      return storage;
    }

    const stored = (storage: InMemorySessionStorage) =>
      JSON.parse(storage.get(`semiont.session.${KB}`) ?? 'null') as { access: string } | null;

    it('does not write back a session that was signed out while it was being renewed, and gives its token to nobody', async () => {
      const storage = seeded();
      fetchMock.mockImplementation(async () => {
        // The sign-out lands while the grant is on its way.
        storage.delete(`semiont.session.${KB}`);
        return reply({ access_token: 'acc-2', refresh_token: 'ref-2' });
      });

      // The issuer renewed it, and there is no session left to hold the token.
      expect(await refreshStoredSession(storage, KB)).toBeNull();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(stored(storage)).toBeNull();
    });

    it('a renewal that finds the stored session already renewed by another context leaves it as it found it, and gives its token', async () => {
      const storage = seeded();
      const renewedElsewhere = JSON.stringify({
        access: 'acc-elsewhere',
        refresh: 'ref-elsewhere',
        clientId: BROWSER_CLIENT_ID,
        tokenEndpoint: `${ISSUER}/token`,
      });
      fetchMock.mockImplementation(async () => {
        // Another context's renewal lands while the grant is on its way.
        storage.set(`semiont.session.${KB}`, renewedElsewhere);
        return reply({ access_token: 'acc-2', refresh_token: 'ref-2' });
      });

      expect(await refreshStoredSession(storage, KB)).toBe('acc-elsewhere');
      expect(storage.get(`semiont.session.${KB}`)).toBe(renewedElsewhere);
    });

    it('rides out a 503 and returns the renewed token', async () => {
      fetchMock
        .mockImplementationOnce(async () => reply(undefined, 503))
        .mockImplementationOnce(async () => reply({ access_token: 'acc-2', refresh_token: 'ref-2' }));
      const storage = seeded();

      expect(await refreshStoredSession(storage, KB)).toBe('acc-2');
      expect(stored(storage)?.access, 'the rotation is persisted').toBe('acc-2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a grant the issuer does not answer is said by the kind of error, with no status and nothing of the answer', async () => {
      fetchMock.mockRejectedValue(unread());

      const failure: unknown = await refreshAtIssuer(`${ISSUER}/token`, BROWSER_CLIENT_ID, 'ref-1').catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(SignInError);
      expect(failure).toMatchObject({ code: 'exchange', message: 'The issuer did not answer: HTTPParserError', status: undefined });
      expect(printed(failure)).not.toContain(UNREAD);
    });

    it('a grant whose answer stops coming was not answered: it states no status, and so is asked again', async () => {
      fetchMock.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ start: (body) => body.error(unread('terminated')) })));

      const failure: unknown = await refreshAtIssuer(`${ISSUER}/token`, BROWSER_CLIENT_ID, 'ref-1').catch((e: unknown) => e);

      expect(failure).toMatchObject({ code: 'exchange', message: 'The issuer did not answer: HTTPParserError', status: undefined });
      expect(printed(failure)).not.toContain(UNREAD);
    });

    it('rides out a network failure, which is the case with no status at all', async () => {
      fetchMock
        .mockImplementationOnce(async () => { throw new TypeError('fetch failed'); })
        .mockImplementationOnce(async () => reply({ access_token: 'acc-2' }));

      expect(await refreshStoredSession(seeded(), KB)).toBe('acc-2');
    });

    it('does NOT retry a refused grant — null on the first answer', async () => {
      // A revoked refresh token cannot become valid. Spending the budget on it
      // only delays a re-login the user has to do anyway.
      fetchMock.mockImplementation(async () => reply({ error: 'invalid_grant' }, 400));

      await expect(refreshStoredSession(seeded(), KB)).rejects.toThrow();
      expect(fetchMock, 'a refusal is final on the first answer').toHaveBeenCalledTimes(1);
    });

    it('does not retry an unclassified fault either — terminal by default', async () => {
      fetchMock.mockImplementation(async () => reply(undefined, 404));

      await expect(refreshStoredSession(seeded(), KB)).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('exhausts a bounded budget and then gives up, rather than retrying forever', async () => {
      // The answer to the objection to retrying before terminating: an
      // invisible zombie session is worse than a visible re-login, so the
      // budget must END.
      fetchMock.mockImplementation(async () => reply(undefined, 503));
      const storage = seeded();

      await expect(refreshStoredSession(storage, KB)).rejects.toThrow();
      expect(fetchMock.mock.calls.length, 'bounded').toBeLessThanOrEqual(4);
      expect(fetchMock.mock.calls.length, 'and it did retry').toBeGreaterThan(1);
      expect(stored(storage), 'the stored session is left for the caller to clear').not.toBeNull();
    });

    it.each([
      { why: 'the last answer\'s status', answer: async () => reply(undefined, 503), status: 503 },
      { why: 'no status when nothing answered', answer: async () => { throw new TypeError('fetch failed'); }, status: undefined },
    ])('an exhausted budget states $why: a session tells it from a refusal by that', async ({ answer, status }) => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(answer);

      const failed = refreshStoredSession(seeded(), KB).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(60_000);
      const failure = await failed;

      expect(failure).toBeInstanceOf(SignInError);
      expect(failure).toMatchObject({ code: 'exchange', message: expect.stringContaining(`${REFRESH_RETRY.attempts} attempts`), status });
      vi.useRealTimers();
    });
  });

  describe('a failed renewal says WHY, and how hard it tried', () => {
    const KB = 'kb-alpha';
    function seeded() {
      const storage = new InMemorySessionStorage();
      storage.set(`semiont.session.${KB}`, JSON.stringify({
        access: 'acc-1', refresh: 'ref-1', clientId: BROWSER_CLIENT_ID,
        tokenEndpoint: `${ISSUER}/token`, issuer: ISSUER,
      }));
      return storage;
    }

    // Returning `null` discards the reason: `tryRefresh` carries a cause only
    // from a THROW, and the session reads it — so a failure throws, and only
    // "nothing is stored" answers null.

    it('throws the issuer\'s own words on a refusal', async () => {
      fetchMock.mockImplementation(async () => reply({ error: 'invalid_grant', error_description: 'revoked' }, 400));

      await expect(refreshStoredSession(seeded(), KB)).rejects.toThrow(/invalid_grant: revoked/);
    });

    it('names the exhausted budget as well as the last cause', async () => {
      // An operator reading "Token refresh failed: HTTP 503" cannot tell
      // whether that was tried once or four times, and the difference decides
      // whether they look at the network or at the issuer.
      fetchMock.mockImplementation(async () => reply(undefined, 503));

      await expect(refreshStoredSession(seeded(), KB)).rejects.toThrow(/4 attempts.*HTTP 503/s);
    });

    it('a storage that will not keep a renewal it took retries to make fails as itself, not as the issuer', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockImplementationOnce(async () => reply(undefined, 503))
        .mockImplementationOnce(async () => reply({ access_token: 'acc-2', refresh_token: 'ref-2' }));
      const storage = seeded();
      const full = new Error('the storage is full');
      vi.spyOn(storage, 'update').mockImplementation(() => {
        throw full;
      });

      const failed = refreshStoredSession(storage, KB).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await failed).toBe(full);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('still answers null — not a throw — when there is simply nothing stored', async () => {
      // An absence is not a failure. The caller distinguishes "never signed in"
      // from "could not renew", and this is the only case that is the former.
      expect(await refreshStoredSession(new InMemorySessionStorage(), KB)).toBeNull();
    });
  });

  it('revokes the refresh token as the client it was issued to', async () => {
    fetchMock.mockImplementation(async () => reply(undefined, 200));

    await revokeAtIssuer(`${ISSUER}/revoke`, SCRIPT_CLIENT_ID, 'ref-1');

    expect(formOf(fetchMock.mock.calls[0]!)).toEqual({ token: 'ref-1', token_type_hint: 'refresh_token', client_id: SCRIPT_CLIENT_ID });
  });
});

describe('the device grant', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function scriptIssuer(polls: Array<{ json: unknown; status?: number }>) {
    const queue = [...polls];
    fetchMock.mockImplementation(async (url: string, init?: { body?: URLSearchParams }) => {
      if (url.endsWith('/.well-known/openid-configuration')) return reply(DISCOVERY);
      if (url === `${ISSUER}/device`) {
        return reply({ device_code: 'dev', user_code: 'ABCD-EFGH', verification_uri: `${ISSUER}/device/verify`, expires_in: 600, interval: 1 });
      }
      if (url === `${ISSUER}/token` && init?.body?.get('grant_type')?.endsWith('device_code')) {
        const next = queue.shift()!;
        return reply(next.json, next.status);
      }
      return reply(undefined, 404);
    });
  }

  it('shows the code, polls while pending, and returns the tokens once approved', async () => {
    scriptIssuer([
      { json: { error: 'authorization_pending' }, status: 400 },
      { json: { access_token: 'acc', refresh_token: 'ref', token_type: 'Bearer' } },
    ]);
    const onCode = vi.fn();

    const result = signInWithDeviceGrant({ target: TARGET, onCode });
    await vi.advanceTimersByTimeAsync(2500);

    await expect(result).resolves.toMatchObject({ issuer: { issuer: ISSUER }, tokens: { access: 'acc', refresh: 'ref' } });
    expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'ABCD-EFGH', verificationUri: `${ISSUER}/device/verify` }));
    const deviceRequest = fetchMock.mock.calls.find(([url]) => url === `${ISSUER}/device`)!;
    expect(formOf(deviceRequest)).toEqual({ client_id: SCRIPT_CLIENT_ID, scope: 'openid email profile offline_access' });
  });

  it('reports a denial at the issuer', async () => {
    scriptIssuer([{ json: { error: 'access_denied' }, status: 400 }]);

    const result = signInWithDeviceGrant({ target: TARGET, onCode: () => {} });
    const outcome = result.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1500);

    expect(await outcome).toBeInstanceOf(SignInError);
    expect(await outcome).toMatchObject({ code: 'denied' });
  });

  it('refuses a device authorization answer that states no lifetime, and shows nobody a code', async () => {
    // RFC 8628 §3.2 requires `expires_in`: one without it has answered
    // without what was asked for.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/.well-known/openid-configuration')) return reply(DISCOVERY);
      if (url === `${ISSUER}/device`) {
        return reply({ device_code: 'dev', user_code: 'ABCD-EFGH', verification_uri: `${ISSUER}/device/verify`, interval: 1 });
      }
      return reply(undefined, 404);
    });
    const onCode = vi.fn();

    const refused = await signInWithDeviceGrant({ target: TARGET, onCode }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(SignInError);
    expect(refused).toMatchObject({ code: 'exchange', message: 'The issuer refused the device authorization request (HTTP 200)' });
    expect(onCode).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => url === `${ISSUER}/token`)).toEqual([]);
  });

  it('refuses an issuer without a device endpoint, naming the client', async () => {
    const { device_authorization_endpoint: _omitted, ...withoutDevice } = DISCOVERY;
    fetchMock.mockImplementation(async () => reply(withoutDevice));

    await expect(signInWithDeviceGrant({ target: TARGET, onCode: () => {} }))
      .rejects.toThrow(new RegExp(SCRIPT_CLIENT_ID));
  });
});

describe('a request to the issuer has a deadline', () => {
  /** The signal each request to the issuer was made under, by URL. */
  function signals(): Array<[string, unknown]> {
    return fetchMock.mock.calls.map(([url, init]) => [url as string, (init as { signal?: unknown } | undefined)?.signal]);
  }

  it('discovery, a grant, a revocation and the device grant each carry the one every SDK keeps', async () => {
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/.well-known/openid-configuration')) return reply(DISCOVERY);
      if (url === `${ISSUER}/device`) {
        return reply({ device_code: 'dev', user_code: 'ABCD-EFGH', verification_uri: `${ISSUER}/device/verify`, expires_in: 600, interval: 1 });
      }
      if (url === `${ISSUER}/token`) return reply({ access_token: 'acc', refresh_token: 'ref', token_type: 'Bearer' });
      if (url === `${ISSUER}/revoke`) return reply({});
      return reply(undefined, 404);
    });

    await discoverIssuer(TARGET);
    await refreshAtIssuer(`${ISSUER}/token`, BROWSER_CLIENT_ID, 'ref');
    await revokeAtIssuer(`${ISSUER}/revoke`, BROWSER_CLIENT_ID, 'ref');
    vi.useFakeTimers();
    const signedIn = signInWithDeviceGrant({ target: TARGET, onCode: () => {} });
    await vi.advanceTimersByTimeAsync(1500);
    await signedIn;
    vi.useRealTimers();

    const made = signals();
    expect(made.map(([url]) => url)).toEqual([
      `${ISSUER}/.well-known/openid-configuration`,
      `${ISSUER}/token`,
      `${ISSUER}/revoke`,
      `${ISSUER}/.well-known/openid-configuration`,
      `${ISSUER}/device`,
      `${ISSUER}/token`,
    ]);
    // One deadline per request, each the shared one, and each the signal
    // its request was made under.
    expect(deadline.mock.calls).toEqual(made.map(() => [HTTP_REQUEST_TIMEOUT_MS]));
    expect(made.map(([, signal]) => signal)).toEqual(deadline.mock.results.map((result) => result.value));
  });

  it('a renewal the issuer never answers is tried again inside the budget, and then says how hard it tried', async () => {
    vi.useFakeTimers();
    const storage = new InMemorySessionStorage();
    storage.set('semiont.session.kb-1', JSON.stringify({
      access: 'a1', refresh: 'r1', clientId: BROWSER_CLIENT_ID, tokenEndpoint: `${ISSUER}/token`,
    }));
    // What a request rejects with when its deadline passes.
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

    const renewed = expect(refreshStoredSession(storage, 'kb-1')).rejects.toThrow(
      `The session could not be renewed after ${REFRESH_RETRY.attempts} attempts: The issuer did not answer: TimeoutError`,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await renewed;

    expect(fetchMock).toHaveBeenCalledTimes(REFRESH_RETRY.attempts);
    vi.useRealTimers();
  });
});
