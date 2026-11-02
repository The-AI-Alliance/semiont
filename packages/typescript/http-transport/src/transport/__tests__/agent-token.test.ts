/**
 * `agentToken` — an agent's sign-in at a knowledge base's gateway.
 *
 * Three requests make one sign-in: the issuer's discovery, the
 * client-credentials grant, and the gateway's answer to who the account is,
 * at `GET /api/users/me`. `fetch` is stubbed and answers each by its URL, so
 * the issuer half is the real `ServiceToken`.
 */
import util from 'node:util';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HTTP_REQUEST_TIMEOUT_MS, STARTUP_FETCH_RETRY, ServiceToken, SignInError } from '@semiont/core';
import { agentToken } from '../agent-token';
import { APIError } from '../api-error';

const GATEWAY = 'http://192.168.64.1:4000';
const DID = 'did:web:kb.example:agents:service-account-semiont-worker';

const ACCOUNT = { issuer: 'https://issuer.test/realms/kb', clientId: 'semiont-worker', clientSecret: 'client-secret' };
const service = () => new ServiceToken(ACCOUNT);

interface Asked {
  url: string;
  init: RequestInit | undefined;
}

/** A `fetch` that answers the issuer, and answers the gateway as `gateway` says. */
function stubFetch(gateway: (asked: Asked) => Response | Promise<Response>, issuer: { grant?: () => Response } = {}) {
  const asked: Asked[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push({ url, init });
    if (url.includes('/.well-known/openid-configuration')) return Response.json({ token_endpoint: `${new URL(url).origin}/token` });
    if (url.endsWith('/token')) return issuer.grant ? issuer.grant() : Response.json({ access_token: 'service-account-token' });
    return gateway({ url, init });
  }));
  return {
    asked,
    gateway: () => asked.filter(({ url }) => url.startsWith(GATEWAY)),
  };
}

/** The gateway's answer to who the account is. */
const named = () => Response.json({ did: DID, email: null, name: null, image: null, domain: 'kb.example' });

const UNREAD = 'what-the-runtime-could-not-read';
/**
 * What Node's `fetch` rejects with when an answer is not HTTP: what it could
 * not read of the answer rides on the cause. Core's own suite sees the
 * runtime make one; here it is made by hand, for requests that are stubbed.
 */
function unread(): TypeError {
  const cause = Object.assign(new Error('Response does not match the HTTP/1.1 protocol (Invalid header token)'), { name: 'HTTPParserError', data: UNREAD });
  return new TypeError('fetch failed', { cause });
}

describe('agentToken', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('signs in as the account: the issuer\'s token is the bearer, and the gateway names who it is', async () => {
    const wire = stubFetch(named);

    const signedIn = await agentToken({ baseUrl: GATEWAY, service: service() });

    // The DID is the gateway's, verbatim: the knowledge base's own domain, and not the host dialled.
    expect(signedIn).toEqual({ token: 'service-account-token', did: DID });
    // Nothing is exchanged: the gateway is asked who the token is, and nothing else.
    const [asked, ...more] = wire.gateway();
    expect(more).toEqual([]);
    expect(asked!.url).toBe(`${GATEWAY}/api/users/me`);
    expect(asked!.init?.method ?? 'GET').toBe('GET');
    expect(new Headers(asked!.init?.headers).get('authorization')).toBe('Bearer service-account-token');
  });

  it('a gateway named with a trailing slash is asked at the same path', async () => {
    const wire = stubFetch(named);
    await agentToken({ baseUrl: `${GATEWAY}/`, service: service() });
    expect(wire.gateway()[0]!.url).toBe(`${GATEWAY}/api/users/me`);
  });

  it('asks the issuer through the fetch its service token was made with, and the gateway through the one it is given', async () => {
    // The runtime's fetch is refused as a far end refuses a request it cannot read: not retried.
    const runtimes = vi.fn(async () => new Response(null, { status: 400 }));
    vi.stubGlobal('fetch', runtimes);
    const urlOf = (input: string | URL | Request) => String(input instanceof Request ? input.url : input);
    const issuer = vi.fn<typeof fetch>(async (input) =>
      urlOf(input).endsWith('/token') ? Response.json({ access_token: 'service-account-token' }) : Response.json({ token_endpoint: 'https://issuer.test/token' }));
    const gateway = vi.fn<typeof fetch>(async () => named());

    await agentToken({ baseUrl: GATEWAY, service: new ServiceToken(ACCOUNT, issuer), fetch: gateway });

    expect(issuer.mock.calls.map(([input]) => urlOf(input))).toEqual([`${ACCOUNT.issuer}/.well-known/openid-configuration`, 'https://issuer.test/token']);
    expect(gateway.mock.calls.map(([input]) => urlOf(input))).toEqual([`${GATEWAY}/api/users/me`]);
    expect(runtimes).not.toHaveBeenCalled();
  });

  it('every request of the sign-in carries the request deadline', async () => {
    // A gateway or an issuer that accepts a connection and never answers
    // would otherwise hold a process's start, and every renewal after it,
    // for as long as the process lives.
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    const wire = stubFetch(named);

    await agentToken({ baseUrl: GATEWAY, service: service() });

    expect(wire.asked).toHaveLength(3);
    for (const { url, init } of wire.asked) expect(init?.signal, url).toBeInstanceOf(AbortSignal);
    expect(deadline.mock.calls).toEqual([[HTTP_REQUEST_TIMEOUT_MS], [HTTP_REQUEST_TIMEOUT_MS], [HTTP_REQUEST_TIMEOUT_MS]]);
  });

  it('a refusal is the gateway\'s answer: it carries the status, says what the gateway said, and is not asked again', async () => {
    const wire = stubFetch(() => Response.json({ error: 'Invalid issuer token' }, { status: 401, statusText: 'Unauthorized' }));

    const refused = await agentToken({ baseUrl: GATEWAY, service: service() }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(APIError);
    expect(refused).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(String(refused)).toContain('The gateway did not name the agent: Invalid issuer token');
    expect(wire.gateway(), 'the gateway is up and said no').toHaveLength(1);
  });

  it('a token refused by the gateway\'s refusal-rate limit is refused like a 401: not asked again, and unauthorized', async () => {
    // A 429 says "not now" unless its code says the token was refused: then
    // the same token gets the same answer, however long the sign-in waits.
    const wire = stubFetch(() => Response.json(
      { error: 'The requests this holder has had refused have used their allowance', code: 'refusal-rate' },
      { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '1' } },
    ));

    const signing = agentToken({ baseUrl: GATEWAY, service: service() }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const refused = await signing;

    expect(refused).toBeInstanceOf(APIError);
    expect(refused).toMatchObject({ status: 429, code: 'unauthorized' });
    expect(wire.gateway(), 'the token was refused, not the request put off').toHaveLength(1);
  });

  it('a 429 from any other limit is still "not now", and the sign-in is tried again', async () => {
    let attempts = 0;
    const wire = stubFetch(() => {
      attempts += 1;
      if (attempts === 1) return Response.json({ error: 'slow down', code: 'emit-rate' }, { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '1' } });
      return named();
    });

    const signing = agentToken({ baseUrl: GATEWAY, service: service() });
    await vi.runAllTimersAsync();

    await expect(signing).resolves.toEqual({ token: 'service-account-token', did: DID });
    expect(wire.gateway()).toHaveLength(2);
  });

  it('a refused service account is the issuer\'s answer, with its status, and the gateway is never asked', async () => {
    const wire = stubFetch(named, { grant: () => new Response('{}', { status: 401 }) });

    const refused = await agentToken({ baseUrl: GATEWAY, service: service() }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(SignInError);
    expect(refused).toMatchObject({
      code: 'exchange',
      status: 401,
      message: `Client-credentials grant for semiont-worker at ${ACCOUNT.issuer} failed (HTTP 401)`,
    });
    expect(wire.gateway()).toHaveLength(0);
  });

  it('an answer that names no DID is refused here', async () => {
    stubFetch(() => Response.json({ email: null, name: null, image: null, domain: 'kb.example' }));
    await expect(agentToken({ baseUrl: GATEWAY, service: service() }))
      .rejects.toThrow(`${GATEWAY}/api/users/me did not answer a DID`);
  });

  it('a gateway that cannot be reached is tried again with backoff, and each wait is told', async () => {
    let attempts = 0;
    const wire = stubFetch(() => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('fetch failed');
      return named();
    });
    const waits: number[] = [];

    const signing = agentToken({
      baseUrl: GATEWAY, service: service(),
      onRetry: ({ attempt }) => waits.push(attempt),
    });
    await vi.runAllTimersAsync();

    await expect(signing).resolves.toEqual({ token: 'service-account-token', did: DID });
    expect(wire.gateway()).toHaveLength(3);
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
      return named();
    });

    const signing = agentToken({ baseUrl: GATEWAY, service: service() });
    await vi.runAllTimersAsync();

    await expect(signing).resolves.toEqual({ token: 'service-account-token', did: DID });
    expect(wire.gateway()).toHaveLength(3);
  });

  it('gives up when the gateway never comes up, with the failure it last saw', async () => {
    const wire = stubFetch(() => { throw new TypeError('fetch failed'); });

    const signing = agentToken({ baseUrl: GATEWAY, service: service() }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    // Nothing answered, and it is said as that: under the code of every request that got no answer, and with no status.
    const failure = await signing;
    expect(failure).toMatchObject({ code: 'unavailable', message: `${GATEWAY}/api/users/me got no answer: TypeError` });
    expect(failure).not.toHaveProperty('status');
    expect(wire.gateway()).toHaveLength(STARTUP_FETCH_RETRY.attempts);
  });

  it('a gateway answer the runtime could not read is asked again, and its failure holds nothing of the answer', async () => {
    const wire = stubFetch(() => { throw unread(); });

    const signing = agentToken({ baseUrl: GATEWAY, service: service() }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const failure = await signing;
    expect(util.inspect(failure, { depth: 6 })).not.toContain(UNREAD);
    expect(failure).toMatchObject({ code: 'unavailable', message: `${GATEWAY}/api/users/me got no answer: HTTPParserError` });
    expect(wire.gateway()).toHaveLength(STARTUP_FETCH_RETRY.attempts);
  });

  it('a gateway answer that stops coming got no answer, and is asked again', async () => {
    const wire = stubFetch(() => new Response(new ReadableStream<Uint8Array>({ start: (body) => body.error(unread()) })));

    const signing = agentToken({ baseUrl: GATEWAY, service: service() }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const failure = await signing;
    expect(util.inspect(failure, { depth: 6 })).not.toContain(UNREAD);
    expect(failure).toMatchObject({ code: 'unavailable', message: `${GATEWAY}/api/users/me got no answer: HTTPParserError` });
    expect(wire.gateway()).toHaveLength(STARTUP_FETCH_RETRY.attempts);
  });

  it('a grant the runtime could not read is asked again too, and its failure holds nothing of the answer', async () => {
    let grants = 0;
    const wire = stubFetch(named, { grant: () => { grants += 1; throw unread(); } });

    const signing = agentToken({ baseUrl: GATEWAY, service: service() }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const failure = await signing;
    expect(util.inspect(failure, { depth: 6 })).not.toContain(UNREAD);
    expect(failure).toMatchObject({
      code: 'unavailable',
      message: `Client-credentials grant for semiont-worker at ${ACCOUNT.issuer} got no answer: HTTPParserError`,
    });
    // The issuer may be starting when this process does: the whole sign-in is made again.
    expect(grants).toBe(STARTUP_FETCH_RETRY.attempts);
    expect(wire.gateway()).toHaveLength(0);
  });
});
