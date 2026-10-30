/**
 * A request that got no answer: what its failure says of why, and what it
 * holds of the exchange.
 *
 * `fetch` rejects with what the runtime made of the failure, and the runtime
 * quotes the exchange in it. Node keeps what it could not read of an answer
 * on the error's cause, and whatever parses a body quotes the body where it
 * stopped. An answer may grant a token, so no part of one may reach a failure
 * that is printed whole.
 *
 * These run against the runtime's own `fetch` and a far end that writes what
 * it is told to, as it is. No server that speaks HTTP frames an answer
 * wrongly, and a stubbed `fetch` rejects only with what the stub was given.
 */
import net from 'node:net';
import util from 'node:util';
import { describe, it, expect, afterEach } from 'vitest';
import { isRetryableRequestError } from '../retry';
import { serviceAccountToken } from '../service-account';
import { UnansweredError, whyUnanswered } from '../unanswered';

/** A token in an answer that signs nobody in. It is a credential all the same. */
const CARRIED = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDAwMzYwMCwibiI6N30.InNpZ25hdHVyZSI';
const GRANT = JSON.stringify({ access_token: CARRIED, token: CARRIED });

/** What is printed of a failure wherever it is logged whole: itself, and whatever it holds, however deep. */
const printed = (failure: unknown): string => util.inspect(failure, { depth: 6 });

/** The runs of six characters of `secret` that `shown` holds: a fragment of a credential is one too. */
function partsOf(secret: string, shown: string): string[] {
  const parts: string[] = [];
  for (let at = 0; at + 6 <= secret.length; at++) {
    const part = secret.slice(at, at + 6);
    if (shown.includes(part)) parts.push(part);
  }
  return parts;
}

/** The grant in each framing that is not HTTP. The runtime keeps what it could not read of each. */
const NOT_HTTP: ReadonlyArray<readonly [string, string]> = [
  ['declared chunked and sent whole', `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${GRANT}\r\n`],
  ['a line that is no header', `HTTP/1.1 200 OK\r\n${GRANT}\r\n\r\n`],
  ['a body where the status line belongs', `${GRANT}\r\n\r\n`],
];

/** An answer that is HTTP, whatever its body is. */
const answering = (body: string): string =>
  `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;

const open: net.Server[] = [];
/** The connections a far end that says nothing was left holding. */
const held: net.Socket[] = [];

/** A far end that writes what `says` gives for a request's path, as it is, and hangs up. Its origin. */
async function farEnd(says: (path: string, origin: string) => string): Promise<string> {
  let origin = '';
  const server = net.createServer((socket) => {
    let asked = '';
    socket.on('error', () => {});
    socket.on('data', (read) => {
      asked += read.toString('latin1');
      if (!asked.includes('\r\n\r\n')) return;
      const path = asked.split(' ')[1] ?? '';
      asked = '';
      socket.end(says(path, origin));
    });
  });
  open.push(server);
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return origin;
}

/** A far end that takes a connection and says nothing. Its origin. */
async function silent(): Promise<string> {
  const server = net.createServer((socket) => {
    held.push(socket);
    socket.on('error', () => {});
  });
  open.push(server);
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** An origin nothing listens at. */
async function nowhere(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((closed) => server.close(() => closed()));
  return `http://127.0.0.1:${port}`;
}

let accounts = 0;
/** A service account at `origin`, at an issuer of its own: an issuer's token endpoint is remembered for the life of the process. */
const account = (origin: string) => ({ issuer: `${origin}/realms/kb-${++accounts}`, clientId: 'semiont-worker', clientSecret: 'client-secret' });

/** The failure a sign-in ends in. */
const failed = (signingIn: Promise<unknown>): Promise<Error> =>
  signingIn.then(
    () => { throw new Error('the sign-in did not fail'); },
    (failure: unknown) => {
      if (!(failure instanceof Error)) throw new Error('the sign-in failed with what is no error');
      return failure;
    },
  );

const discovered = (origin: string): string => answering(JSON.stringify({ token_endpoint: `${origin}/token` }));

afterEach(async () => {
  held.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(open.splice(0).map((server) => new Promise<void>((closed) => server.close(() => closed()))));
});

describe('a service account whose issuer answers what is not HTTP', () => {
  it.each(NOT_HTTP)('to its discovery (%s): the failure says the kind of error, and holds nothing of the answer', async (_framing, raw) => {
    const credential = account(await farEnd(() => raw));

    const failure = await failed(serviceAccountToken(credential, { renewed: false }));

    expect(partsOf(CARRIED, printed(failure))).toEqual([]);
    expect(failure.message).toMatch(new RegExp(`^OIDC discovery for ${credential.issuer} got no answer: [A-Za-z][A-Za-z0-9_]*$`));
    // Nothing answered, so it is worth asking again: an issuer may be starting when this process does.
    expect(isRetryableRequestError(failure)).toBe(true);
  });

  it.each(NOT_HTTP)('to its grant (%s): the failure says the kind of error, and holds nothing of the answer', async (_framing, raw) => {
    const credential = account(await farEnd((path, origin) => (path.endsWith('/token') ? raw : discovered(origin))));

    const failure = await failed(serviceAccountToken(credential, { renewed: false }));

    expect(partsOf(CARRIED, printed(failure))).toEqual([]);
    expect(failure.message).toMatch(
      new RegExp(`^Client-credentials grant for semiont-worker at ${credential.issuer} got no answer: [A-Za-z][A-Za-z0-9_]*$`),
    );
    expect(isRetryableRequestError(failure)).toBe(true);
  });
});

describe('a service account whose issuer answers what is not JSON', () => {
  // Whatever parses a body says where it stopped, and quotes the body there: here, the token.
  it('to its discovery: the document names no token endpoint, and none of it is said', async () => {
    const credential = account(await farEnd(() => answering(`{"token_endpoint": ${CARRIED}}`)));

    const failure = await failed(serviceAccountToken(credential, { renewed: false }));

    expect(partsOf(CARRIED, printed(failure))).toEqual([]);
    expect(failure.message).toBe(`OIDC discovery for ${credential.issuer} returned no \`token_endpoint\``);
    // It answered, and its answer was final.
    expect(isRetryableRequestError(failure)).toBe(false);
  });

  it('to its grant: the answer grants no token, and none of it is said', async () => {
    const credential = account(await farEnd((path, origin) => (path.endsWith('/token') ? answering(`{"access_token": ${CARRIED}}`) : discovered(origin))));

    const failure = await failed(serviceAccountToken(credential, { renewed: false }));

    expect(partsOf(CARRIED, printed(failure))).toEqual([]);
    expect(failure.message).toBe(`Token endpoint for ${credential.issuer} returned no \`access_token\``);
    expect(isRetryableRequestError(failure)).toBe(false);
  });
});

describe('a service account whose issuer cannot be reached', () => {
  it('says so by the code the runtime gives the failed connection', async () => {
    const credential = account(await nowhere());

    const failure = await failed(serviceAccountToken(credential, { renewed: false }));

    // What whoever runs the process needs, in the failure's own line: it is not left on a cause.
    expect(failure.message).toBe(`OIDC discovery for ${credential.issuer} got no answer: ECONNREFUSED`);
    expect(isRetryableRequestError(failure)).toBe(true);
  });
});

describe('why a request got no answer', () => {
  it('is the name alone of an error whose words quote the request: a header value the runtime will not send', async () => {
    const refusal: unknown = await fetch(await nowhere(), { headers: { authorization: `Bearer one line\nand ${CARRIED}` } }).catch((e: unknown) => e);

    // The premise: the runtime says the value it refused.
    expect(partsOf(CARRIED, String(refusal))).not.toEqual([]);
    expect(whyUnanswered(refusal)).toBe('TypeError');
    expect(partsOf(CARRIED, printed(new UnansweredError('POST /bus/emit', refusal)))).toEqual([]);
  });

  it('is the code of what caused it, when its own words quote the request: a URL that is none', async () => {
    const refusal: unknown = await fetch(`http://user:${CARRIED}@:none/`).catch((e: unknown) => e);

    expect(partsOf(CARRIED, String(refusal))).not.toEqual([]);
    expect(whyUnanswered(refusal)).toBe('ERR_INVALID_URL');
    expect(partsOf(CARRIED, printed(new UnansweredError('GET a URL that is none', refusal)))).toEqual([]);
  });

  it('is the name of a deadline that passed', async () => {
    const refusal: unknown = await fetch(await silent(), { signal: AbortSignal.timeout(20) }).catch((e: unknown) => e);

    expect(whyUnanswered(refusal)).toBe('TimeoutError');
  });

  it('is nothing of a rejection that is no error, and nothing of a code that is words', () => {
    expect(whyUnanswered(`aborted, holding ${CARRIED}`)).toBe('Error');
    const worded = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: `words, and ${CARRIED}` }) });
    expect(whyUnanswered(worded)).toBe('TypeError');
  });

  it('is said by a failure that states no status, holds nothing it was made from, and is worth another attempt', () => {
    const failure = new UnansweredError('GET /api/health', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }));

    expect(failure).toMatchObject({ name: 'UnansweredError', code: 'unavailable', message: 'GET /api/health got no answer: ECONNREFUSED' });
    expect(failure).not.toHaveProperty('status');
    expect(failure.cause).toBeUndefined();
    expect(isRetryableRequestError(failure)).toBe(true);
  });
});
