/**
 * `agentToken` — an agent's sign-in at a knowledge base's gateway.
 *
 * Three requests make one sign-in: the issuer's discovery, the
 * client-credentials grant, and the exchange at `POST /api/tokens/agent`.
 * `fetch` is stubbed and answers each by its URL, so the issuer half is the
 * real `serviceAccountToken`. Each test signs in at an issuer of its own:
 * core remembers an issuer's token endpoint for the life of the process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HTTP_REQUEST_TIMEOUT_MS, STARTUP_FETCH_RETRY } from '@semiont/core';
import { agentToken } from '../agent-token';
import { APIError } from '../api-error';

const GATEWAY = 'http://192.168.64.1:4000';
const DID = 'did:web:kb.example:agents:anthropic:claude-haiku-4-5';

let issuers = 0;
function credential() {
  return { issuer: `https://issuer-${++issuers}.test/realms/kb`, clientId: 'semiont-worker', clientSecret: 'client-secret' };
}

interface Asked {
  url: string;
  init: RequestInit | undefined;
}

/** A `fetch` that answers the issuer, and answers the exchange as `exchange` says. */
function stubFetch(exchange: (asked: Asked) => Response | Promise<Response>, issuer: { grant?: () => Response } = {}) {
  const asked: Asked[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push({ url, init });
    if (url.includes('/.well-known/openid-configuration')) return Response.json({ token_endpoint: `${new URL(url).origin}/token` });
    if (url.endsWith('/token')) return issuer.grant ? issuer.grant() : Response.json({ access_token: 'service-account-token' });
    return exchange({ url, init });
  }));
  return {
    asked,
    exchanges: () => asked.filter(({ url }) => url.endsWith('/api/tokens/agent')),
  };
}

const minted = () => Response.json({ token: 'agent-token', did: DID });

describe('agentToken', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('presents the service account\'s token, names the agent, and returns what the gateway minted', async () => {
    const wire = stubFetch(minted);

    const signedIn = await agentToken({ baseUrl: GATEWAY, credential: credential(), provider: 'anthropic', model: 'claude-haiku-4-5' });

    // The DID is the gateway's, verbatim: the knowledge base's own domain, and not the host dialled.
    expect(signedIn).toEqual({ token: 'agent-token', did: DID });
    const [exchange] = wire.exchanges();
    expect(exchange!.url).toBe(`${GATEWAY}/api/tokens/agent`);
    expect(exchange!.init?.method).toBe('POST');
    expect(new Headers(exchange!.init?.headers).get('authorization')).toBe('Bearer service-account-token');
    expect(JSON.parse(String(exchange!.init?.body))).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('a gateway named with a trailing slash is asked at the same path', async () => {
    const wire = stubFetch(minted);
    await agentToken({ baseUrl: `${GATEWAY}/`, credential: credential(), provider: 'ollama', model: 'gemma3:4b' });
    expect(wire.exchanges()[0]!.url).toBe(`${GATEWAY}/api/tokens/agent`);
  });

  it('every request of the sign-in carries the request deadline', async () => {
    // A gateway or an issuer that accepts a connection and never answers
    // would otherwise hold a process's start, and every renewal after it,
    // for as long as the process lives.
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    const wire = stubFetch(minted);

    await agentToken({ baseUrl: GATEWAY, credential: credential(), provider: 'ollama', model: 'gemma3:4b' });

    expect(wire.asked).toHaveLength(3);
    for (const { url, init } of wire.asked) expect(init?.signal, url).toBeInstanceOf(AbortSignal);
    expect(deadline.mock.calls).toEqual([[HTTP_REQUEST_TIMEOUT_MS], [HTTP_REQUEST_TIMEOUT_MS], [HTTP_REQUEST_TIMEOUT_MS]]);
  });

  it('a refusal is the gateway\'s answer: it carries the status, names the agent, and is not asked again', async () => {
    const wire = stubFetch(() => Response.json({ error: 'Invalid issuer token' }, { status: 401, statusText: 'Unauthorized' }));

    const refused = await agentToken({ baseUrl: GATEWAY, credential: credential(), provider: 'anthropic', model: 'claude-haiku-4-5' }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(APIError);
    expect(refused).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(String(refused)).toContain('anthropic:claude-haiku-4-5');
    expect(String(refused)).toContain('Invalid issuer token');
    expect(wire.exchanges(), 'the gateway is up and said no').toHaveLength(1);
  });

  it('a refused service account is the issuer\'s answer, and the gateway is never asked', async () => {
    const wire = stubFetch(minted, { grant: () => new Response('{}', { status: 401 }) });
    const account = credential();

    await expect(agentToken({ baseUrl: GATEWAY, credential: account, provider: 'ollama', model: 'gemma3:4b' }))
      .rejects.toThrow(`Client-credentials grant for semiont-worker at ${account.issuer} failed (HTTP 401)`);
    expect(wire.exchanges()).toHaveLength(0);
  });

  it('an answer with no token, or no DID, is refused here', async () => {
    stubFetch(() => Response.json({ token: 'agent-token' }));
    await expect(agentToken({ baseUrl: GATEWAY, credential: credential(), provider: 'ollama', model: 'gemma3:4b' }))
      .rejects.toThrow(/ollama:gemma3:4b.*no token or no DID/);
  });

  it('a gateway that cannot be reached is tried again with backoff, and each wait is told', async () => {
    let attempts = 0;
    const wire = stubFetch(() => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('fetch failed');
      return minted();
    });
    const waits: number[] = [];

    const signing = agentToken({
      baseUrl: GATEWAY, credential: credential(), provider: 'ollama', model: 'gemma3:4b',
      onRetry: ({ attempt }) => waits.push(attempt),
    });
    await vi.runAllTimersAsync();

    await expect(signing).resolves.toEqual({ token: 'agent-token', did: DID });
    expect(wire.exchanges()).toHaveLength(3);
    expect(waits).toEqual([1, 2]);
  });

  it('a request whose deadline passes, and a gateway that says "not now", are tried again too', async () => {
    // A request that bounds itself is rejected with a TimeoutError when the
    // bound fires. A sign-in that gave up on it would never be made again by
    // a process run with no restart policy.
    let attempts = 0;
    const wire = stubFetch(() => {
      attempts += 1;
      if (attempts === 1) throw new DOMException('The operation timed out.', 'TimeoutError');
      if (attempts === 2) return new Response('', { status: 503, statusText: 'Service Unavailable' });
      return minted();
    });

    const signing = agentToken({ baseUrl: GATEWAY, credential: credential(), provider: 'ollama', model: 'gemma3:4b' });
    await vi.runAllTimersAsync();

    await expect(signing).resolves.toEqual({ token: 'agent-token', did: DID });
    expect(wire.exchanges()).toHaveLength(3);
  });

  it('gives up when the gateway never comes up, with the failure it last saw', async () => {
    const wire = stubFetch(() => { throw new TypeError('fetch failed'); });

    const signing = agentToken({ baseUrl: GATEWAY, credential: credential(), provider: 'ollama', model: 'gemma3:4b' }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await signing).toBeInstanceOf(TypeError);
    expect(wire.exchanges()).toHaveLength(STARTUP_FETCH_RETRY.attempts);
  });
});
