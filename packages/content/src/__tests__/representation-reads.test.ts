/**
 * A resource's bytes, read from the Archivist: what is asked of it, what a
 * read answers, and the one way a read misses.
 *
 * The issuer and the Archivist are a stubbed `fetch`. A token costs two calls
 * of the issuer (its discovery document, then the client-credentials grant);
 * the read is a call of the Archivist.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { resourceId, type ServiceAccountCredential } from '@semiont/core';
import { archivistContentReads, RepresentationMissing } from '../representation-reads';

const ISSUER = 'https://issuer.test/realms/semiont';
const TOKEN = 'a-service-account-token';
const ARCHIVIST = 'http://archivist.internal:9999';
const CONFIG = { services: { archivist: { host: 'archivist.internal', port: 9999 } } };

const CREDENTIAL: ServiceAccountCredential = {
  issuer: ISSUER,
  clientId: 'semiont-librarian',
  clientSecret: 'a-secret',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What the Archivist was asked: the URL of a read, and the credential it was shown. */
interface Asked {
  url: string;
  authorization: string | undefined;
}

/**
 * Serves the issuer, and answers every call of the Archivist with `answer()`.
 * Any other URL is a fault of the test.
 */
function serve(answer: () => Response): Asked[] {
  const asked: Asked[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: { headers?: Record<string, string> }) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({ issuer: ISSUER, token_endpoint: `${ISSUER}/token` });
    }
    if (url === `${ISSUER}/token`) {
      return json({ access_token: TOKEN, expires_in: 300 });
    }
    if (url.startsWith(`${ARCHIVIST}/`)) {
      asked.push({ url, authorization: init?.headers?.['authorization'] });
      return answer();
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  return asked;
}

const read = () => archivistContentReads(CONFIG, CREDENTIAL).getBinary(resourceId('doc-123'));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('archivistContentReads', () => {
  it("asks the Archivist for the resource's content, and shows it the service account's token", async () => {
    const asked = serve(() => new Response('# A title', { headers: { 'content-type': 'text/markdown' } }));

    const { data, contentType } = await read();

    expect(asked).toEqual([{ url: `${ARCHIVIST}/resources/doc-123/content`, authorization: `Bearer ${TOKEN}` }]);
    expect(Buffer.from(data).toString('utf8')).toBe('# A title');
    expect(contentType).toBe('text/markdown');
  });

  it('answers application/octet-stream for bytes the Archivist states no type of', async () => {
    serve(() => new Response(new Uint8Array([1, 2, 3])));

    const { data, contentType } = await read();

    expect([...new Uint8Array(data)]).toEqual([1, 2, 3]);
    expect(contentType).toBe('application/octet-stream');
  });

  it.each(['resource', 'representation'] as const)('takes a 404 whose code is "%s" as a miss of that half', async (code) => {
    serve(() => json({ error: 'not found', code }, 404));

    const missed = read();

    await expect(missed).rejects.toBeInstanceOf(RepresentationMissing);
    await expect(missed).rejects.toMatchObject({ resourceId: 'doc-123', reason: code });
  });

  it('takes a 404 that states no such code as an error, and no miss', async () => {
    serve(() => json({ error: 'no such route' }, 404));

    const failed = read();

    await expect(failed).rejects.toThrow('a 404 that is not a RepresentationNotFound');
    await expect(failed).rejects.not.toBeInstanceOf(RepresentationMissing);
  });

  it('takes a 404 whose body is no JSON as an error too', async () => {
    serve(() => new Response('not found', { status: 404 }));

    await expect(read()).rejects.toThrow('a 404 that is not a RepresentationNotFound');
  });

  it('names the resource and the status of any other refusal', async () => {
    serve(() => new Response('boom', { status: 500, statusText: 'Internal Server Error' }));

    await expect(read()).rejects.toThrow('Archivist content read failed for doc-123: 500 Internal Server Error');
  });

  it('is not made where no Archivist is configured, and asks nothing', () => {
    const asked = serve(() => new Response(''));

    expect(() => archivistContentReads({ services: {} }, CREDENTIAL)).toThrow(/services\.archivist\.host/);
    expect(asked).toEqual([]);
  });
});

describe('RepresentationMissing', () => {
  it('names the resource, and which half of the lookup failed', () => {
    const resource = new RepresentationMissing('doc-123', 'resource');
    const representation = new RepresentationMissing('doc-123', 'representation');

    expect(resource.name).toBe('RepresentationMissing');
    expect(resource.message).toBe('Resource not found: doc-123');
    expect(representation.message).toBe('Resource representation not found: no storageUri for doc-123');
  });
});
