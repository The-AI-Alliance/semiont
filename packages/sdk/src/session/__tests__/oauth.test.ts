/**
 * The session layer as an OAuth public client (EXTERNAL-IDENTITY P4): issuer
 * discovery from a KB's resource metadata, the authorization-code grant with
 * PKCE, the device grant, refresh, and revocation — against a fetch stub,
 * with the issuer's answers scripted per case. Nothing here names a vendor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIError, HttpTransport } from '@semiont/http-transport';
import { InMemorySessionStorage } from '../session-storage';
import {
  BROWSER_CLIENT_ID,
  PENDING_AUTHORIZATION_KEY,
  SCRIPT_CLIENT_ID,
  SignInError,
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
      if (json === undefined) throw new Error('no body');
      return json;
    },
  } as unknown as Response;
}

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
  it('derives the S256 challenge of RFC 7636 appendix B', async () => {
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
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

  it('names a KB that trusts no issuer', async () => {
    metadata.mockRejectedValue(new APIError('Not Found', 404, 'Not Found'));

    await expect(discoverIssuer(TARGET)).rejects.toMatchObject({ code: 'no-issuer' });
  });

  it('refuses a discovery document that names a different issuer', async () => {
    fetchMock.mockImplementation(async () => reply({ ...DISCOVERY, issuer: 'https://other.test' }));

    await expect(discoverIssuer(TARGET)).rejects.toMatchObject({ code: 'discovery' });
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
    expect(url.searchParams.get('code_challenge')).toBe(await codeChallenge(record.verifier));
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

  it('takes a rotated refresh token', async () => {
    fetchMock.mockImplementation(async () => reply({ access_token: 'acc-2', refresh_token: 'ref-2' }));

    expect(await refreshAtIssuer(`${ISSUER}/token`, BROWSER_CLIENT_ID, 'ref-1')).toEqual({ access: 'acc-2', refresh: 'ref-2' });
  });

  it('surfaces the issuer refusal', async () => {
    fetchMock.mockImplementation(async () => reply({ error: 'invalid_grant', error_description: 'revoked' }, 400));

    await expect(refreshAtIssuer(`${ISSUER}/token`, BROWSER_CLIENT_ID, 'ref-1'))
      .rejects.toThrow(/invalid_grant: revoked/);
  });

  // ── REFRESH-FAILURE-TRANSIENT-VS-TERMINAL P2 ─────────────────────────
  // `refreshStoredSession` answered `null` for every failure, and its caller
  // treats `null` as terminal — so a lost packet ended the session exactly
  // like a revocation. The issuer's answer is the verdict; its absence is not.
  //
  // The retry lives HERE and not in the session on purpose: SSE-AUTH-RESILIENCE
  // P0 settled that a session terminates on `null`, and rejected retry-on-throw
  // with "Retry belongs in the callback, which owns the HTTP call."

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

    it('rides out a 503 and returns the renewed token', async () => {
      fetchMock
        .mockImplementationOnce(async () => reply(undefined, 503))
        .mockImplementationOnce(async () => reply({ access_token: 'acc-2', refresh_token: 'ref-2' }));
      const storage = seeded();

      expect(await refreshStoredSession(storage, KB)).toBe('acc-2');
      expect(stored(storage)?.access, 'the rotation is persisted').toBe('acc-2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
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
      // The answer to SSE-AUTH-RESILIENCE's objection: an invisible zombie
      // session is worse than a visible re-login, so the budget must END.
      fetchMock.mockImplementation(async () => reply(undefined, 503));
      const storage = seeded();

      await expect(refreshStoredSession(storage, KB)).rejects.toThrow();
      expect(fetchMock.mock.calls.length, 'bounded').toBeLessThanOrEqual(4);
      expect(fetchMock.mock.calls.length, 'and it did retry').toBeGreaterThan(1);
      expect(stored(storage), 'the stored session is left for the caller to clear').not.toBeNull();
    });
  });

  describe('a failed renewal says WHY, and how hard it tried (D4)', () => {
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
    // from a THROW. SSE-AUTH-RESILIENCE made throw and null equivalent at the
    // session precisely so the informative one could be used — so a failure
    // throws, and only "nothing is stored" answers null.

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

  it('refuses an issuer without a device endpoint, naming the client', async () => {
    const { device_authorization_endpoint: _omitted, ...withoutDevice } = DISCOVERY;
    fetchMock.mockImplementation(async () => reply(withoutDevice));

    await expect(signInWithDeviceGrant({ target: TARGET, onCode: () => {} }))
      .rejects.toThrow(new RegExp(SCRIPT_CLIENT_ID));
  });
});
