/**
 * `@semiont/core/testing/issuer` — an in-process OIDC issuer: it holds signing
 * keys, signs tokens with the ones it publishes (or, on request, with one it
 * does not), and hands out the two documents a verifier fetches. The JWKS sits
 * at a path only discovery reveals, so a verifier that guesses
 * `/.well-known/jwks.json` fails against it.
 *
 * It SERVES nothing. Keys, signatures and document shape are what a verifier
 * suite actually needs; how those two URLs get answered is the consumer's —
 * the gateway routes them through the MSW server its whole suite already runs,
 * core's own suite stubs `fetch`. Owning the transport here would mean core
 * taking a network-interception dependency to answer two URLs, and forcing it
 * on everyone importing this subpath.
 *
 * `discoveryFetches` / `jwksFetches` still count, because reading a document
 * is what increments them — the cooldown test depends on that and would
 * otherwise have to be reimplemented per consumer.
 */
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { CryptoKey, JWK, JWTPayload } from 'jose';

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
  /** Where the two documents live, so a consumer can route to them. */
  readonly discoveryUrl: string;
  readonly jwksUrl: string;
  /** The OIDC discovery document. Reading it counts. */
  discoveryDocument(): { issuer: string; jwks_uri: string };
  /** The published key set. Reading it counts. */
  jwks(): { keys: JWK[] };
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

  return {
    issuer: origin,
    audience: options.audience,
    discoveryUrl: `${origin}/.well-known/openid-configuration`,
    jwksUrl: `${origin}/keys`,
    discoveryDocument() {
      discoveryFetches++;
      return { issuer: advertisedIssuer, jwks_uri: `${origin}/keys` };
    },
    jwks() {
      jwksFetches++;
      return { keys: keys.map((k) => k.jwk) };
    },
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
