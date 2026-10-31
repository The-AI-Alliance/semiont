/**
 * A service account's assertion of itself, signed with its own key (RFC 7523
 * §2.2, OpenID Connect's `private_key_jwt`).
 *
 * The issuer holds the key's public half, registered on the account's client,
 * and checks the signature with it: the private key never leaves the process,
 * and no secret is sent. The assertion's shape is
 * specs/src/session/client-assertion-cases.json's.
 *
 * The key is WebCrypto's, which a browser withholds from a page that is not a
 * secure context. A page never holds a service account's key: a worker does,
 * and a worker is a process.
 */

import { base64url } from './base64url';
import { sha256 } from './sha256';

/** The grant's `client_assertion_type` for an assertion that is a JWT. */
export const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** How long after it is made an assertion is good for. */
export const LIFETIME_SECONDS = 60;

/** An RSA key's public members as a JWK states them: base64url, unpadded, of the unsigned big-endian bytes. */
export interface RsaPublicMembers {
  n: string;
  e: string;
}

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

const PKCS8_PEM = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/;
const NOT_PKCS8_PEM = 'The key is not a PKCS#8 PEM private key: one that begins `-----BEGIN PRIVATE KEY-----`';
const NOT_RSA = 'The PEM holds no RSA private key: a service account signs its assertions with RS256';
const NOT_RS256 = 'The key does not sign RS256 (RSASSA-PKCS1-v1_5 with SHA-256): read it with `privateKeyFromPem`';

const utf8 = new TextEncoder();
const segment = (value: object): string => base64url(utf8.encode(JSON.stringify(value)));

/** The key's JWK thumbprint (RFC 7638): the SHA-256 of `e`, `kty` and `n`, in that order, with no whitespace. */
export function thumbprint({ n, e }: RsaPublicMembers): string {
  return base64url(sha256(utf8.encode(`{"e":"${e}","kty":"RSA","n":"${n}"}`)));
}

/** An assertion's header: RS256, and the key it is signed with, by its thumbprint. */
export function assertionHeader(key: RsaPublicMembers): { alg: 'RS256'; kid: string } {
  return { alg: 'RS256', kid: thumbprint(key) };
}

/** An assertion's claims: the client is its issuer and its subject, and the token endpoint its audience. */
export function assertionClaims(
  clientId: string,
  tokenEndpoint: string,
  { issuedAt, jti }: { issuedAt: number; jti: string },
): { iss: string; sub: string; aud: string; jti: string; iat: number; exp: number } {
  return { iss: clientId, sub: clientId, aud: tokenEndpoint, jti, iat: issuedAt, exp: issuedAt + LIFETIME_SECONDS };
}

/**
 * The RSA private key a PKCS#8 PEM holds (`-----BEGIN PRIVATE KEY-----`), as a
 * key that signs RS256. A PEM that is not PKCS#8, or holds a key that is not
 * RSA, is refused, and the refusal never repeats it.
 *
 * The key is extractable: an assertion names it by its thumbprint, and its
 * public members are read by exporting it.
 */
export async function privateKeyFromPem(pem: string): Promise<CryptoKey> {
  const armored = PKCS8_PEM.exec(pem.trim());
  if (armored === null) throw new Error(NOT_PKCS8_PEM);
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = Uint8Array.from(atob(armored[1].replace(/\s/g, '')), (char) => char.charCodeAt(0));
  } catch {
    throw new Error(NOT_PKCS8_PEM);
  }
  try {
    return await crypto.subtle.importKey('pkcs8', der, RS256, true, ['sign']);
  } catch {
    throw new Error(NOT_RSA);
  }
}

/** The assertion, signed: a compact JWT of `assertionHeader` and `assertionClaims`, RS256 with `privateKey`. */
export async function clientAssertion(
  privateKey: CryptoKey,
  clientId: string,
  tokenEndpoint: string,
  made: { issuedAt: number; jti: string },
): Promise<string> {
  const { kty, alg, n, e } = await crypto.subtle.exportKey('jwk', privateKey);
  if (kty !== 'RSA' || alg !== 'RS256' || n === undefined || e === undefined) throw new Error(NOT_RS256);
  const signingInput = `${segment(assertionHeader({ n, e }))}.${segment(assertionClaims(clientId, tokenEndpoint, made))}`;
  const signature = await crypto.subtle.sign(RS256, privateKey, utf8.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
