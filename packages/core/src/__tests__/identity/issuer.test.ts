/**
 * JWKS consumption (EXTERNAL-IDENTITY P2): a foreign issuer's token verifies by
 * the keys that issuer publishes — found through OIDC discovery, selected by
 * `kid`, cached, and refreshed without a restart. Real signatures against an
 * in-process issuer; nothing here names a vendor.
 *
 * These live in CORE because `IssuerVerifier` is core's. They ran under the
 * gateway until 2026-09-20, which meant `npm test --workspace=@semiont/core`
 * could pass on a broken verifier — and `@semiont/core/identity` is a
 * published subpath with three consumers.
 *
 * Imported from SOURCE, not from `@semiont/core/identity`: a suite that tests
 * its own package through the built artifact reports on the last build, not on
 * the working tree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT, errors } from 'jose';
import { accessToken } from '../../index';
import { IssuerVerifier, type IssuerVerifierOptions } from '../../identity/issuer';
import { fixtureIssuer, type FixtureIssuer } from '../../testing/issuer';

const ORIGIN = 'https://issuer.test';
const AUDIENCE = 'semiont-gateway';

let issuer: FixtureIssuer;

// Two URLs answered, so two URLs are stubbed. The gateway routes the same
// fixture through the MSW server its whole suite already runs; core answers
// `fetch` directly rather than take a network-interception dependency to serve
// a discovery document and a key set.
function serve(...issuers: FixtureIssuer[]): void {
  const routes = new Map<string, () => unknown>();
  for (const i of issuers) {
    routes.set(i.discoveryUrl, () => i.discoveryDocument());
    routes.set(i.jwksUrl, () => i.jwks());
  }
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = routes.get(url);
    if (!body) throw new Error(`unstubbed fetch: ${url}`);
    return new Response(JSON.stringify(body()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  issuer = await fixtureIssuer(ORIGIN, { audience: AUDIENCE });
  serve(issuer);
});

function verifier(jwks: IssuerVerifierOptions['jwks'] = { cooldownDuration: 0 }): IssuerVerifier {
  return new IssuerVerifier({ issuer: ORIGIN, audience: AUDIENCE, jwks });
}

async function verify(v: IssuerVerifier, token: string) {
  return v.verify(accessToken(token));
}

describe('a token from the issuer', () => {
  it('verifies by the key published under its `kid`', async () => {
    const payload = await verify(verifier(), await issuer.token({ claims: { sub: 'alice' } }));

    expect(payload.sub).toBe('alice');
    expect(payload.iss).toBe(ORIGIN);
    expect(payload.aud).toBe(AUDIENCE);
  });

  it('reaches the JWKS through discovery, and reads discovery once', async () => {
    const v = verifier();
    await verify(v, await issuer.token());
    await verify(v, await issuer.token());

    expect(issuer.discoveryFetches).toBe(1);
    expect(issuer.jwksFetches).toBe(1);
  });
});

describe('a token that must not verify', () => {
  it('claims a `kid` the issuer does not publish', async () => {
    const token = await issuer.token({ kid: 'nope', privateKey: await issuer.unpublishedKey() });

    await expect(verify(verifier(), token)).rejects.toBeInstanceOf(errors.JWKSNoMatchingKey);
  });

  it('claims a published `kid` but was signed by another key', async () => {
    const token = await issuer.token({ kid: 'k1', privateKey: await issuer.unpublishedKey() });

    await expect(verify(verifier(), token)).rejects.toBeInstanceOf(errors.JWSSignatureVerificationFailed);
  });

  it('names a different issuer', async () => {
    const token = await issuer.token({ issuer: 'https://other.test' });

    await expect(verify(verifier(), token)).rejects.toMatchObject({
      constructor: errors.JWTClaimValidationFailed,
      claim: 'iss',
    });
  });

  it('is for another audience', async () => {
    const token = await issuer.token({ audience: 'someone-else' });

    await expect(verify(verifier(), token)).rejects.toMatchObject({
      constructor: errors.JWTClaimValidationFailed,
      claim: 'aud',
    });
  });

  it('has expired', async () => {
    const token = await issuer.token({ expiresIn: new Date(Date.now() - 60_000) });

    await expect(verify(verifier(), token)).rejects.toBeInstanceOf(errors.JWTExpired);
  });

  it('uses a symmetric algorithm, whatever key it claims', async () => {
    const token = await new SignJWT({ sub: 'alice' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(ORIGIN)
      .setAudience(AUDIENCE)
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('a-shared-secret-at-least-32-bytes-long'));

    await expect(verify(verifier(), token)).rejects.toBeInstanceOf(errors.JOSEAlgNotAllowed);
  });
});

describe('the key cache', () => {
  it('picks up a key added to the JWKS without a restart', async () => {
    const v = verifier({ cooldownDuration: 0 });
    await verify(v, await issuer.token({ kid: 'k1' }));
    expect(issuer.jwksFetches).toBe(1);

    await issuer.addKey('k2');
    const payload = await verify(v, await issuer.token({ kid: 'k2' }));

    expect(payload.sub).toBe('user-1');
    expect(issuer.jwksFetches).toBe(2);
  });

  it('refetches for an unknown `kid` no more often than the cooldown', async () => {
    const v = verifier({ cooldownDuration: 60_000 });
    await verify(v, await issuer.token({ kid: 'k1' }));
    const unknown = await issuer.token({ kid: 'k9', privateKey: await issuer.unpublishedKey() });

    await expect(verify(v, unknown)).rejects.toBeInstanceOf(errors.JWKSNoMatchingKey);
    await expect(verify(v, unknown)).rejects.toBeInstanceOf(errors.JWKSNoMatchingKey);

    expect(issuer.jwksFetches).toBe(1);
  });
});

describe('discovery', () => {
  it('refuses a document whose `issuer` is not the configured one', async () => {
    const origin = 'https://mislabeled.test';
    serve(await fixtureIssuer(origin, { audience: AUDIENCE, advertisedIssuer: 'https://other.test' }));
    const v = new IssuerVerifier({ issuer: origin, audience: AUDIENCE, jwks: { cooldownDuration: 0 } });

    await expect(v.verify(accessToken('any.token.here'))).rejects.toThrow(/different issuer/);
  });
});
