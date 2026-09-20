/**
 * An in-process OIDC issuer: publishes discovery and a JWKS over MSW, signs
 * tokens with the keys it publishes (or, on request, with one it does not).
 * The JWKS lives at a path only discovery can reveal, so a verifier that
 * guesses `/.well-known/jwks.json` fails against it.
 */
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { CryptoKey, JWK, JWTPayload } from 'jose';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';

interface IssuerKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

export interface TokenOptions {
  /** Which published key signs; the newest when omitted. */
  kid?: string;
  /** Sign with this key instead of the published one under `kid`. */
  privateKey?: CryptoKey;
  issuer?: string;
  audience?: string;
  /** jose's expiration input: a duration like '10m' or an absolute Date. */
  expiresIn?: string | Date;
  claims?: JWTPayload;
}

export interface FixtureIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly discoveryFetches: number;
  readonly jwksFetches: number;
  addKey(kid: string): Promise<void>;
  token(options?: TokenOptions): Promise<string>;
  /** A keypair the issuer never publishes. */
  unpublishedKey(): Promise<CryptoKey>;
}

async function rsaKey(kid: string): Promise<IssuerKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, jwk };
}

export async function fixtureIssuer(
  origin: string,
  options: { audience: string; advertisedIssuer?: string },
): Promise<FixtureIssuer> {
  const keys: IssuerKey[] = [await rsaKey('k1')];
  const advertisedIssuer = options.advertisedIssuer ?? origin;
  let discoveryFetches = 0;
  let jwksFetches = 0;

  server.use(
    http.get(`${origin}/.well-known/openid-configuration`, () => {
      discoveryFetches++;
      return HttpResponse.json({ issuer: advertisedIssuer, jwks_uri: `${origin}/keys` });
    }),
    http.get(`${origin}/keys`, () => {
      jwksFetches++;
      return HttpResponse.json({ keys: keys.map((k) => k.jwk) });
    }),
  );

  return {
    issuer: origin,
    audience: options.audience,
    get discoveryFetches() {
      return discoveryFetches;
    },
    get jwksFetches() {
      return jwksFetches;
    },
    async addKey(kid) {
      keys.push(await rsaKey(kid));
    },
    async token(tokenOptions = {}) {
      const newest = keys[keys.length - 1]!;
      const kid = tokenOptions.kid ?? newest.kid;
      const published = keys.find((k) => k.kid === kid);
      const privateKey = tokenOptions.privateKey ?? published?.privateKey;
      if (!privateKey) throw new Error(`fixture issuer publishes no key '${kid}' and none was supplied`);
      return new SignJWT({ sub: 'user-1', ...tokenOptions.claims })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(tokenOptions.issuer ?? origin)
        .setAudience(tokenOptions.audience ?? options.audience)
        .setIssuedAt()
        .setExpirationTime(tokenOptions.expiresIn ?? '10m')
        .sign(privateKey);
    },
    async unpublishedKey() {
      return (await generateKeyPair('RS256')).privateKey;
    },
  };
}
