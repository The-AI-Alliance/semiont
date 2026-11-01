/**
 * `ServiceToken` — a process's own sign-in at the issuer.
 *
 * Two requests: the issuer's discovery, then the client-credentials grant.
 * `fetch` is stubbed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { HTTP_REQUEST_TIMEOUT_MS } from '../generated/client-timing';
import { ServiceToken } from '../service-account';
import { SignInError } from '../sign-in-error';

const ACCOUNT = { issuer: 'https://issuer.test/realms/kb', clientId: 'semiont-worker', clientSecret: 'client-secret' };

interface Asked {
  url: string;
  init: RequestInit | undefined;
}

/** A `fetch` that answers the issuer's discovery itself and the grant with `grant`, and the requests it was sent. */
function issuerFetch(grant: () => Response) {
  const asked: Asked[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push({ url, init });
    return url.includes('/.well-known/openid-configuration') ? Response.json({ token_endpoint: `${new URL(url).origin}/token` }) : grant();
  });
  return { fetch, asked };
}

function stubFetch(grant: () => Response) {
  const { fetch, asked } = issuerFetch(grant);
  vi.stubGlobal('fetch', fetch);
  return asked;
}

const discoveries = (asked: Asked[]) => asked.filter(({ url }) => url.endsWith('/.well-known/openid-configuration'));
const grants = (asked: Asked[]) => asked.filter(({ url }) => url.endsWith('/token'));

describe('ServiceToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('discovers the token endpoint, then presents the credential for the grant', async () => {
    const asked = stubFetch(() => Response.json({ access_token: 'service-account-token' }));

    await expect(new ServiceToken(ACCOUNT).token({ renewed: false })).resolves.toBe('service-account-token');

    expect(asked.map(({ url }) => url)).toEqual([`${ACCOUNT.issuer}/.well-known/openid-configuration`, 'https://issuer.test/token']);
    expect(String(asked[1]!.init?.body)).toBe('grant_type=client_credentials&client_id=semiont-worker&client_secret=client-secret');
  });

  it('bounds the discovery and the grant by the request deadline', async () => {
    // An issuer that accepts a connection and never answers would otherwise
    // hold a process's start, and every renewal after it, for as long as the
    // process lives.
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    const asked = stubFetch(() => Response.json({ access_token: 'service-account-token' }));

    await new ServiceToken(ACCOUNT).token({ renewed: false });

    expect(asked).toHaveLength(2);
    for (const { url, init } of asked) expect(init?.signal, url).toBeInstanceOf(AbortSignal);
    expect(deadline.mock.calls).toEqual([[HTTP_REQUEST_TIMEOUT_MS], [HTTP_REQUEST_TIMEOUT_MS]]);
  });

  it('a refusal names the client and the issuer, with the status and never the body', async () => {
    stubFetch(() => Response.json({ error: 'invalid_client', echoed: 'client-secret' }, { status: 401 }));

    const refused = await new ServiceToken(ACCOUNT).token({ renewed: false }).catch((e: unknown) => e);

    expect(String(refused)).toContain(`Client-credentials grant for semiont-worker at ${ACCOUNT.issuer} failed (HTTP 401)`);
    expect(String(refused)).not.toContain('client-secret');
    // The status rides as a field: a refused account and a lost packet are told apart by it, not by the message.
    expect(refused).toBeInstanceOf(SignInError);
    expect(refused).toMatchObject({ code: 'exchange', status: 401 });
  });

  it('gives the `Authorization` header\'s value: the token held, renewed when it is due', async () => {
    let granted = 0;
    const asked = stubFetch(() => Response.json({ access_token: `service-account-token-${++granted}`, expires_in: 300 }));
    const service = new ServiceToken(ACCOUNT);

    await expect(service.authorization()).resolves.toBe('Bearer service-account-token-1');
    await expect(service.authorization(), 'the token held').resolves.toBe('Bearer service-account-token-1');
    expect(grants(asked)).toHaveLength(1);
  });

  it('makes one grant at a time: those who ask while one is under way are given what it brings', async () => {
    let granted = 0;
    const asked = stubFetch(() => Response.json({ access_token: `service-account-token-${++granted}`, expires_in: 300 }));
    const service = new ServiceToken(ACCOUNT);

    const tokens = await Promise.all([service.token({ renewed: false }), service.token({ renewed: false }), service.token({ renewed: false })]);

    expect(tokens).toEqual(['service-account-token-1', 'service-account-token-1', 'service-account-token-1']);
    expect(grants(asked)).toHaveLength(1);
  });

  it('a grant that fails is its own asker\'s failure, and the next ask makes another', async () => {
    let granted = 0;
    const asked = stubFetch(() =>
      ++granted === 1 ? Response.json({ error: 'temporarily_unavailable' }, { status: 503 }) : Response.json({ access_token: 'service-account-token', expires_in: 300 }),
    );
    const service = new ServiceToken(ACCOUNT);

    const [failed, next] = await Promise.allSettled([service.token({ renewed: false }), service.token({ renewed: false })]);

    expect(failed).toMatchObject({ status: 'rejected', reason: { code: 'exchange', status: 503 } });
    expect(next).toEqual({ status: 'fulfilled', value: 'service-account-token' });
    expect(grants(asked)).toHaveLength(2);
  });

  it('holds the token until it is due, and asks for another at once when renewed', async () => {
    let granted = 0;
    const asked = stubFetch(() => Response.json({ access_token: `service-account-token-${++granted}`, expires_in: 300 }));
    const service = new ServiceToken(ACCOUNT);

    await expect(service.token({ renewed: false })).resolves.toBe('service-account-token-1');
    await expect(service.token({ renewed: false }), 'the token held').resolves.toBe('service-account-token-1');
    await expect(service.token({ renewed: true }), 'a new grant').resolves.toBe('service-account-token-2');
    await expect(service.token({ renewed: false }), 'the new token, held in place of the old').resolves.toBe('service-account-token-2');

    expect(grants(asked)).toHaveLength(2);
  });

  it('a token whose grant reports no lifetime is not held, and neither is the one it replaced', async () => {
    let granted = 0;
    const asked = stubFetch(() => {
      granted += 1;
      return Response.json(granted === 1 ? { access_token: 'service-account-token-1', expires_in: 300 } : { access_token: `service-account-token-${granted}` });
    });
    const service = new ServiceToken(ACCOUNT);

    await service.token({ renewed: false });
    await expect(service.token({ renewed: true })).resolves.toBe('service-account-token-2');
    await expect(service.token({ renewed: false }), 'a new grant, and never the token replaced').resolves.toBe('service-account-token-3');

    expect(grants(asked)).toHaveLength(3);
  });

  it('discovers its issuer once, however many grants it asks for', async () => {
    let granted = 0;
    const asked = stubFetch(() => Response.json({ access_token: `service-account-token-${++granted}` }));
    const service = new ServiceToken(ACCOUNT);

    await service.token({ renewed: false });
    await service.token({ renewed: true });
    await service.token({ renewed: true });

    expect(discoveries(asked)).toHaveLength(1);
    expect(grants(asked)).toHaveLength(3);
  });

  it('each service token discovers its issuer through its own fetch, and asks for its grants through it', async () => {
    // Two holders of one account at one issuer: what one learned is not the other's.
    const first = issuerFetch(() => Response.json({ access_token: 'first-token', expires_in: 300 }));
    const second = issuerFetch(() => Response.json({ access_token: 'second-token', expires_in: 300 }));

    await expect(new ServiceToken(ACCOUNT, first.fetch).token({ renewed: false })).resolves.toBe('first-token');
    await expect(new ServiceToken(ACCOUNT, second.fetch).token({ renewed: false })).resolves.toBe('second-token');

    for (const { asked } of [first, second]) {
      expect(asked.map(({ url }) => url)).toEqual([`${ACCOUNT.issuer}/.well-known/openid-configuration`, 'https://issuer.test/token']);
    }
  });

  it('a discovery that failed is not held: the next ask discovers again', async () => {
    // An issuer still booting when the process starts must be asked again, not remembered as down.
    let discovered = 0;
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      if (url.endsWith('/token')) return Response.json({ access_token: 'service-account-token' });
      discovered += 1;
      return discovered === 1 ? new Response('', { status: 503 }) : Response.json({ token_endpoint: `${new URL(url).origin}/token` });
    }));
    const service = new ServiceToken(ACCOUNT);

    await expect(service.token({ renewed: false })).rejects.toMatchObject({ code: 'discovery', status: 503 });
    await expect(service.token({ renewed: false })).resolves.toBe('service-account-token');

    expect(asked).toEqual([
      `${ACCOUNT.issuer}/.well-known/openid-configuration`,
      `${ACCOUNT.issuer}/.well-known/openid-configuration`,
      'https://issuer.test/token',
    ]);
  });
});
