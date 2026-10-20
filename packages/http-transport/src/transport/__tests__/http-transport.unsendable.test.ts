/**
 * What the runtime will not make a request of, and what the transport says
 * of it.
 *
 * A request is made of an address and, most often, a token. The runtime
 * refuses a header value that is none, a token with a line break inside it
 * among them, and an address that is no URL or carries a credential; and it
 * says the value, or the address, in refusing. ky makes its request before
 * any hook of its own runs, so the refusal comes out of ky as the runtime made
 * it, in the promise ky hands back.
 *
 * ky is the real one here, and so are the runtime's `Request` and `Headers`:
 * the refusal is the runtime's own. `fetch` is stubbed, since nothing is to
 * be sent.
 */
import util from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { accessToken, baseUrl, resourceId, type AccessToken, type SemiontError } from '@semiont/core';
import { HttpContentTransport } from '../http-content-transport';
import { HttpTransport, currentUserOf } from '../http-transport';

/** A token, which is a credential whether or not a request can carry it. */
const CARRIED = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE4MDAwMDAwMDAsIm4iOjd9.InNpZ25hdHVyZSI';
/** The same token with a line break inside it: no header's value. */
const BROKEN = accessToken(`${CARRIED.slice(0, 24)}\n${CARRIED.slice(24)}`);
const GATEWAY = baseUrl('http://gateway.test');
/** An address that carries a credential: the runtime makes no request of one. */
const CREDENTIALED = baseUrl(`http://user:${CARRIED}@gateway.test`);
const RESOURCE = resourceId('res-1');

/** Whether what is printed of a failure, wherever it is logged whole, holds any part of the token. */
function says(failure: unknown): boolean {
  const printed = util.inspect(failure, { depth: 6 });
  for (let at = 0; at + 6 <= CARRIED.length; at++) {
    if (printed.includes(CARRIED.slice(at, at + 6))) return true;
  }
  return false;
}

let fetched: ReturnType<typeof vi.fn>;
/** What was asked of the gateway, the stream's own connect aside. */
const asked = (): string[] =>
  fetched.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input)).filter((url) => !url.endsWith('/bus/subscribe'));

const open: HttpTransport[] = [];
function transportWith(token: AccessToken, address = GATEWAY, more: { tokenRefresher?: () => Promise<string | null> } = {}): HttpTransport {
  const transport = new HttpTransport({ baseUrl: address, token$: new BehaviorSubject<AccessToken | null>(token), ...more });
  open.push(transport);
  return transport;
}

beforeEach(() => {
  // The stream connects as soon as there is a token. Its connect is held, and every other request is refused.
  fetched = vi.fn(async (input: string | URL | Request) =>
    String(input instanceof Request ? input.url : input).endsWith('/bus/subscribe')
      ? new Promise<Response>(() => {})
      : Response.json({ error: 'The token is not one this gateway admits' }, { status: 401 }));
  vi.stubGlobal('fetch', fetched);
});

afterEach(() => {
  open.splice(0).forEach((transport) => transport.dispose());
  vi.unstubAllGlobals();
});

type Asking = (transport: HttpTransport, content: HttpContentTransport) => Promise<unknown>;

const REQUESTS: ReadonlyArray<readonly [string, Asking]> = [
  ['GET /api/users/me', (transport) => transport.getCurrentUser()],
  ['POST /api/tokens/media', (transport) => transport.getMediaToken(RESOURCE)],
  ['GET /api/health', (transport) => transport.healthCheck()],
  ['GET /api/status', (transport) => transport.getStatus()],
  ['GET /resources/res-1', (_transport, content) => content.getBinary(RESOURCE)],
  ['GET /resources/res-1', (_transport, content) => content.getBinaryStream(RESOURCE)],
  ['GET /resources/res-1/jsonld', (_transport, content) => content.getResourceGraph(RESOURCE)],
  ['GET /resources/res-1/anchored-text', (_transport, content) => content.getAnchoredText(RESOURCE)],
  ['POST /resources', (_transport, content) => content.putBinary({ name: 'a note', file: Buffer.from('a note'), format: 'text/plain', storageUri: 'file://a-note.txt' })],
];

describe('a request of a token that is no header value', () => {
  it.each(REQUESTS)('%s got no answer: it says the kind of error, and none of the token', async (request, asking) => {
    const transport = transportWith(BROKEN);
    const reported: SemiontError[] = [];
    transport.errors$.subscribe((error) => reported.push(error));

    const failure: unknown = await asking(transport, new HttpContentTransport(transport)).catch((e: unknown) => e);

    expect(says(failure)).toBe(false);
    expect(failure).toMatchObject({ name: 'APIError', code: 'unavailable', message: `${request} got no answer: TypeError` });
    // It is on the transport's error stream, as every request that got no answer is.
    expect(reported).toEqual([failure]);
    expect(asked()).toEqual([]);
  });

  it('asked of a gateway with no transport: the asking rejects, and does not throw where it was called', async () => {
    let asking: Promise<unknown> | undefined;
    expect(() => {
      asking = currentUserOf(GATEWAY, BROKEN);
    }).not.toThrow();

    const failure: unknown = await asking?.catch((e: unknown) => e);

    expect(says(failure)).toBe(false);
    expect(failure).toMatchObject({ name: 'APIError', code: 'unavailable', message: 'GET /api/users/me got no answer: TypeError' });
    expect(asked()).toEqual([]);
  });

  it('handed back by a refresher after a refusal: it is no fresh credential, and the refusal is the answer', async () => {
    const transport = transportWith(accessToken('a-token-the-gateway-refuses'), GATEWAY, { tokenRefresher: async () => BROKEN });

    const failure: unknown = await transport.getCurrentUser().catch((e: unknown) => e);

    expect(says(failure)).toBe(false);
    expect(failure).toMatchObject({ name: 'APIError', code: 'unauthorized', status: 401 });
    // The request was made once, and not again with a token it could not carry.
    expect(asked()).toEqual(['http://gateway.test/api/users/me']);
  });
});

describe('a request of an address that carries a credential', () => {
  it.each(REQUESTS)('%s got no answer: it says the kind of error, and none of the address', async (request, asking) => {
    const transport = transportWith(accessToken('a-token'), CREDENTIALED);

    const failure: unknown = await asking(transport, new HttpContentTransport(transport)).catch((e: unknown) => e);

    expect(says(failure)).toBe(false);
    expect(failure).toMatchObject({ name: 'APIError', code: 'unavailable', message: `${request} got no answer: TypeError` });
    expect(asked()).toEqual([]);
  });

  it('asked of a gateway with no transport: the asking rejects, and says none of the address', async () => {
    const failure: unknown = await Promise.resolve()
      .then(() => currentUserOf(CREDENTIALED, accessToken('a-token')))
      .catch((e: unknown) => e);

    expect(says(failure)).toBe(false);
    expect(failure).toMatchObject({ name: 'APIError', code: 'unavailable', message: 'GET /api/users/me got no answer: TypeError' });
    expect(asked()).toEqual([]);
  });
});
