/**
 * A service account that proves itself with a key: each grant carries an
 * assertion signed for it alone, and no secret.
 *
 * What an issuer does with the assertion is done here by hand: its signature
 * is checked with the key's public half, and its claims read. `fetch` is
 * stubbed. The shape the table states is `client-assertion-cases.test.ts`'s;
 * the form a grant posts is read from the same table,
 * specs/src/session/client-assertion-cases.json.
 */
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import util from 'node:util';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JWT_BEARER, LIFETIME_SECONDS, privateKeyFromPem, thumbprint } from '../client-assertion';
import { ServiceToken, type KeyCredential } from '../service-account';
import { SignInError } from '../sign-in-error';
import { isObject } from '../type-guards';

const table: { form: string[]; grantType: string } = JSON.parse(
  readFileSync(new URL('../../../../../specs/src/session/client-assertion-cases.json', import.meta.url), 'utf8'),
);

const CLIENT = 'semiont-worker-alice-laptop';

const ISSUER = 'https://issuer.test/realms/kb';

function rsaKey(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
}

/** The key's public members, as its JWK states them. */
function publicMembers(publicKey: KeyObject): { n: string; e: string } {
  const { n, e } = publicKey.export({ format: 'jwk' });
  if (n === undefined || e === undefined) throw new Error('an RSA public key has `n` and `e`');
  return { n, e };
}

function stubFetch(grant: (form: URLSearchParams) => Response) {
  const grants: URLSearchParams[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/.well-known/openid-configuration')) return Response.json({ token_endpoint: `${new URL(url).origin}/token` });
    expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(init?.body));
    grants.push(form);
    return grant(form);
  }));
  return grants;
}

/** A JWT segment's JSON. */
function decoded(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** The assertion's header and claims, once its signature is checked with `publicKey`, as an issuer checks it. */
function checked(assertion: string, publicKey: KeyObject): { header: unknown; claims: Record<string, unknown> } {
  const [head, body, signature, ...rest] = assertion.split('.');
  if (head === undefined || body === undefined || signature === undefined || rest.length > 0) throw new Error('an assertion is a compact JWT');
  if (!verify('sha256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url'))) throw new Error('the signature is not the key\'s');
  const claims = decoded(body);
  if (!isObject(claims)) throw new Error('an assertion\'s claims are an object');
  return { header: decoded(head), claims };
}

/** A form field that was sent once. */
function field(form: URLSearchParams, name: string): string {
  const values = form.getAll(name);
  expect(values, name).toHaveLength(1);
  return values[0]!;
}

/** The runs of six characters of `secret` that `shown` holds: a fragment of a key is one too. */
function partsOf(secret: string, shown: string): string[] {
  const parts: string[] = [];
  for (let at = 0; at + 6 <= secret.length; at++) {
    const part = secret.slice(at, at + 6);
    if (shown.includes(part)) parts.push(part);
  }
  return parts;
}

/** A PEM's base64 body, which is the key. */
const bodyOf = (pem: string): string => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');

describe('a key credential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('each grant carries an assertion signed for it alone, and no secret', async () => {
    let granted = 0;
    const grants = stubFetch(() => Response.json({ access_token: `service-account-token-${++granted}`, expires_in: 300 }));
    const { pem, publicKey } = rsaKey();
    const account: KeyCredential = { issuer: ISSUER, clientId: CLIENT, privateKey: await privateKeyFromPem(pem) };

    const service = new ServiceToken(account);

    await expect(service.token({ renewed: false })).resolves.toBe('service-account-token-1');
    await expect(service.token({ renewed: true })).resolves.toBe('service-account-token-2');

    expect(grants).toHaveLength(2);
    const jtis: unknown[] = [];
    for (const form of grants) {
      expect([...form.keys()].sort()).toEqual([...table.form].sort());
      expect([field(form, 'grant_type'), field(form, 'client_assertion_type')]).toEqual([table.grantType, JWT_BEARER]);
      const { header, claims } = checked(field(form, 'client_assertion'), publicKey);
      expect(header).toEqual({ alg: 'RS256', kid: thumbprint(publicMembers(publicKey)) });
      expect([claims.iss, claims.sub, claims.aud]).toEqual([CLIENT, CLIENT, `${new URL(account.issuer).origin}/token`]);
      const { iat, exp } = claims;
      if (typeof iat !== 'number' || typeof exp !== 'number') throw new Error('`iat` and `exp` are numbers');
      expect(Number.isInteger(iat), 'iat is in whole seconds').toBe(true);
      expect(exp - iat).toBe(LIFETIME_SECONDS);
      expect(Math.abs(iat - Date.now() / 1000)).toBeLessThan(60);
      expect(typeof claims.jti).toBe('string');
      jtis.push(claims.jti);
    }
    expect(jtis[0], 'a grant\'s assertion is never sent twice').not.toBe(jtis[1]);
  });

  it('an assertion another key signed is not this account\'s', async () => {
    const grants = stubFetch(() => Response.json({ access_token: 'service-account-token' }));
    const { pem } = rsaKey();

    await new ServiceToken({ issuer: ISSUER, clientId: CLIENT, privateKey: await privateKeyFromPem(pem) }).token({ renewed: false });

    const [form] = grants;
    expect(() => checked(field(form!, 'client_assertion'), rsaKey().publicKey)).toThrow('the signature is not the key\'s');
  });

  it('never shows its key, and a refused grant never shows its assertion', async () => {
    const grants = stubFetch((form) => Response.json({ error: 'invalid_client', echoed: form.toString() }, { status: 401 }));
    const { pem } = rsaKey();
    const account: KeyCredential = { issuer: ISSUER, clientId: CLIENT, privateKey: await privateKeyFromPem(pem) };
    const { d } = await crypto.subtle.exportKey('jwk', account.privateKey);
    if (d === undefined) throw new Error('an RSA private key has `d`');

    for (const shown of [util.inspect(account, { depth: 6 }), JSON.stringify(account), String(account)]) {
      expect(partsOf(bodyOf(pem), shown)).toEqual([]);
      expect(partsOf(d, shown)).toEqual([]);
    }

    // An error body can echo what it was sent: the status is said, never the body.
    const refused = await new ServiceToken(account).token({ renewed: false }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SignInError);
    expect(refused).toMatchObject({ code: 'exchange', status: 401 });
    expect(String(refused)).toContain(`Client-credentials grant for ${CLIENT} at ${account.issuer} failed (HTTP 401)`);
    const assertion = field(grants[0]!, 'client_assertion');
    for (const part of assertion.split('.')) expect(util.inspect(refused, { depth: 6 })).not.toContain(part);
  });

  it('signs RS256 alone: a key of another algorithm is refused before anything is sent', async () => {
    const grants = stubFetch(() => Response.json({ access_token: 'service-account-token' }));
    const { privateKey } = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );

    await expect(new ServiceToken({ issuer: ISSUER, clientId: CLIENT, privateKey }).token({ renewed: false })).rejects.toThrow(
      'The key does not sign RS256',
    );
    expect(grants).toEqual([]);
  });
});

describe('privateKeyFromPem', () => {
  it('reads the RSA key of a PKCS#8 PEM, which signs RS256', async () => {
    const { pem, publicKey } = rsaKey();
    const read = await privateKeyFromPem(pem);
    expect(read.type).toBe('private');
    expect(read.usages).toEqual(['sign']);
    const { n, e, alg } = await crypto.subtle.exportKey('jwk', read);
    expect({ n, e, alg }).toEqual({ ...publicMembers(publicKey), alg: 'RS256' });
  });

  it('refuses what is not an RSA key in a PKCS#8 PEM, and never repeats it', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const refusals: ReadonlyArray<readonly [string, string, string]> = [
      ['text that is no PEM', 'not a key at all', 'is not a PKCS#8 PEM private key'],
      ['an RSA key in PKCS#1, not PKCS#8', rsa.export({ type: 'pkcs1', format: 'pem' }).toString(), 'is not a PKCS#8 PEM private key'],
      ['a PKCS#8 PEM whose body is not base64', '-----BEGIN PRIVATE KEY-----\nAAAAA\n-----END PRIVATE KEY-----', 'is not a PKCS#8 PEM private key'],
      ['a PKCS#8 PEM whose body is no key', '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', 'holds no RSA private key'],
      ['an EC key in PKCS#8', ec.export({ type: 'pkcs8', format: 'pem' }).toString(), 'holds no RSA private key'],
    ];
    for (const [why, pem, said] of refusals) {
      const refused = await privateKeyFromPem(pem).catch((error: unknown) => error);
      expect(refused, why).toBeInstanceOf(Error);
      expect(String(refused), why).toContain(said);
      expect(partsOf(bodyOf(pem), util.inspect(refused, { depth: 6 })), why).toEqual([]);
    }
  });
});
