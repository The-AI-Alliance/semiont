/**
 * `serviceAccountToken` — a process's own sign-in at the issuer.
 *
 * Two requests: the issuer's discovery, then the client-credentials grant.
 * `fetch` is stubbed. Each test names an issuer of its own, because the token
 * endpoint an issuer publishes is remembered for the life of the process.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { HTTP_REQUEST_TIMEOUT_MS } from '../generated/client-timing';
import { serviceAccountToken } from '../service-account';

let issuers = 0;
const credential = () => ({ issuer: `https://issuer-${++issuers}.test/realms/kb`, clientId: 'semiont-worker', clientSecret: 'client-secret' });

function stubFetch(grant: () => Response) {
  const asked: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push({ url, init });
    return url.includes('/.well-known/openid-configuration') ? Response.json({ token_endpoint: `${new URL(url).origin}/token` }) : grant();
  }));
  return asked;
}

describe('serviceAccountToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('discovers the token endpoint, then presents the credential for the grant', async () => {
    const asked = stubFetch(() => Response.json({ access_token: 'service-account-token' }));
    const account = credential();

    await expect(serviceAccountToken(account)).resolves.toBe('service-account-token');

    expect(asked.map(({ url }) => url)).toEqual([`${account.issuer}/.well-known/openid-configuration`, 'https://issuer-1.test/token']);
    expect(String(asked[1]!.init?.body)).toBe('grant_type=client_credentials&client_id=semiont-worker&client_secret=client-secret');
  });

  it('bounds the discovery and the grant by the request deadline', async () => {
    // An issuer that accepts a connection and never answers would otherwise
    // hold a process's start, and every renewal after it, for as long as the
    // process lives.
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    const asked = stubFetch(() => Response.json({ access_token: 'service-account-token' }));

    await serviceAccountToken(credential());

    expect(asked).toHaveLength(2);
    for (const { url, init } of asked) expect(init?.signal, url).toBeInstanceOf(AbortSignal);
    expect(deadline.mock.calls).toEqual([[HTTP_REQUEST_TIMEOUT_MS], [HTTP_REQUEST_TIMEOUT_MS]]);
  });

  it('a refusal names the client and the issuer, with the status and never the body', async () => {
    stubFetch(() => Response.json({ error: 'invalid_client', echoed: 'client-secret' }, { status: 401 }));
    const account = credential();

    const refused = await serviceAccountToken(account).catch((e: unknown) => e);

    expect(String(refused)).toContain(`Client-credentials grant for semiont-worker at ${account.issuer} failed (HTTP 401)`);
    expect(String(refused)).not.toContain('client-secret');
  });
});
