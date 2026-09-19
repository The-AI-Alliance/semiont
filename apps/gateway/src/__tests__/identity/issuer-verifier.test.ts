/**
 * JWKS consumption (EXTERNAL-IDENTITY P2): a foreign issuer's token verifies by
 * the keys that issuer publishes — found through OIDC discovery, selected by
 * `kid`, cached, and refreshed without a restart. Real signatures against an
 * in-process issuer; nothing here names a vendor.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT, errors } from 'jose';
import { accessToken } from '@semiont/core';
import { IssuerVerifier, type IssuerVerifierOptions } from '@semiont/core/identity';
import { fixtureIssuer, type FixtureIssuer } from '../fixtures/issuer';

const ORIGIN = 'https://issuer.test';
const AUDIENCE = 'semiont-gateway';

let issuer: FixtureIssuer;

beforeEach(async () => {
  issuer = await fixtureIssuer(ORIGIN, { audience: AUDIENCE });
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
    await fixtureIssuer(origin, { audience: AUDIENCE, advertisedIssuer: 'https://other.test' });
    const v = new IssuerVerifier({ issuer: origin, audience: AUDIENCE, jwks: { cooldownDuration: 0 } });

    await expect(v.verify(accessToken('any.token.here'))).rejects.toThrow(/different issuer/);
  });
});
