/**
 * A service account's assertion of itself, held to
 * specs/src/session/client-assertion-cases.json.
 *
 * The table states the shape: the thumbprint a key is named by, and the header
 * and claims an assertion carries. The signature over them, and the form a
 * grant posts, are held in `key-credential.test.ts`, where a grant's assertion
 * is checked with the key's public half as an issuer checks it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JWT_BEARER, LIFETIME_SECONDS, assertionClaims, assertionHeader, thumbprint, type RsaPublicMembers } from '../client-assertion';

interface Jwk extends RsaPublicMembers {
  kty: string;
}

interface Table {
  assertionType: string;
  lifetimeSeconds: number;
  thumbprints: Array<{ why: string; jwk: Jwk; thumbprint: string }>;
  cases: Array<{
    why: string;
    jwk: Jwk;
    clientId: string;
    tokenEndpoint: string;
    issuedAt: number;
    jti: string;
    header: unknown;
    claims: unknown;
  }>;
}

const table: Table = JSON.parse(
  readFileSync(new URL('../../../../../specs/src/session/client-assertion-cases.json', import.meta.url), 'utf8'),
);

describe('a service account\'s assertion (specs/src/session/client-assertion-cases.json)', () => {
  it('has thumbprints and cases, each of an RSA key', () => {
    expect(table.thumbprints.length).toBeGreaterThan(0);
    expect(table.cases.length).toBeGreaterThan(0);
    for (const { why, jwk } of [...table.thumbprints, ...table.cases]) expect(jwk.kty, why).toBe('RSA');
  });

  describe('a key is named by its thumbprint', () => {
    for (const { why, jwk, thumbprint: named } of table.thumbprints) {
      it(why, () => {
        expect(thumbprint(jwk)).toBe(named);
      });
    }
  });

  describe('an assertion carries the header and claims the table states', () => {
    for (const { why, jwk, clientId, tokenEndpoint, issuedAt, jti, header, claims } of table.cases) {
      it(why, () => {
        expect(assertionHeader(jwk)).toEqual(header);
        expect(assertionClaims(clientId, tokenEndpoint, { issuedAt, jti })).toEqual(claims);
      });
    }
  });

  it('an assertion is of the table\'s type and lives as long as it says', () => {
    // The form a grant posts is held where a grant is made, in key-credential.test.ts.
    expect(JWT_BEARER).toBe(table.assertionType);
    expect(LIFETIME_SECONDS).toBe(table.lifetimeSeconds);
  });
});
