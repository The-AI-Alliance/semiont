/**
 * The client-credentials grant, for a process authenticating as ITSELF.
 *
 * A sidecar holds its own account at the knowledge base's issuer and exchanges
 * that credential for a short-lived token. It then presents that token to the
 * gateway to obtain a software-agent token — two different identities on
 * purpose: this is the PROCESS, and the agent DID is the WORK it is doing.
 * One worker process legitimately holds several agent identities at once, so
 * the two could never have been the same credential.
 *
 * This replaced a single shared secret that every sidecar carried and that the
 * gateway compared by string equality. That secret granted any agent identity
 * to anyone holding it, and could only be rotated by restarting the stack.
 *
 * The token endpoint is discovered rather than constructed. Every issuer
 * publishes it; guessing a vendor's path would put that vendor's layout in
 * code that has no other reason to know it.
 */

import { isObject, isString } from './type-guards';

export interface ServiceAccountCredential {
  /** The issuer URL, exactly as it appears in tokens' `iss`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/** Cache discovery per issuer: it is a fixed document and the process is long-lived. */
const tokenEndpoints = new Map<string, Promise<string>>();

/**
 * Cached tokens, keyed by issuer and client.
 *
 * Without this, a caller that resolves its credential per request — the
 * Archivist's content reads do, because a token held for the life of the
 * process would expire in it — would hit the issuer on every read.
 *
 * The lifetime comes from `expires_in` on the grant response, which is the
 * protocol's own field rather than a number restated here. Deliberately not
 * the JWT's `exp`: a client-credentials access token is not required to be a
 * JWT, and reading one would be assuming a shape the grant does not promise.
 */
const tokens = new Map<string, { token: string; expiresAt: number }>();

/** Renew this long before expiry, so a token never expires mid-flight. */
const RENEW_BEFORE_EXPIRY_MS = 30_000;

async function tokenEndpoint(issuer: string): Promise<string> {
  let endpoint = tokenEndpoints.get(issuer);
  if (!endpoint) {
    endpoint = (async () => {
      const url = new URL(
        '.well-known/openid-configuration',
        issuer.endsWith('/') ? issuer : `${issuer}/`,
      );
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`OIDC discovery for ${issuer} failed: HTTP ${response.status} from ${url}`);
      }
      const document: unknown = await response.json();
      if (!isObject(document) || !isString(document['token_endpoint'])) {
        throw new Error(`OIDC discovery for ${issuer} returned no \`token_endpoint\``);
      }
      return document['token_endpoint'];
    })().catch((error: unknown) => {
      // Do not cache a failure: a discovery that failed because the issuer was
      // still booting must be retried, not remembered.
      tokenEndpoints.delete(issuer);
      throw error;
    });
    tokenEndpoints.set(issuer, endpoint);
  }
  return endpoint;
}

/**
 * Obtain an access token for this service account.
 *
 * Throws on refusal rather than returning null: a sidecar that cannot prove who
 * it is has nothing useful to do, and the caller's retry policy decides whether
 * this is worth attempting again.
 */
export async function serviceAccountToken(credential: ServiceAccountCredential): Promise<string> {
  const { issuer, clientId, clientSecret } = credential;

  const key = `${issuer}\u0000${clientId}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - RENEW_BEFORE_EXPIRY_MS > Date.now()) {
    return cached.token;
  }

  const endpoint = await tokenEndpoint(issuer);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    // The status, not the body: a token endpoint's error body can echo the
    // request, and this one carried a secret.
    throw new Error(
      `Client-credentials grant for ${clientId} at ${issuer} failed (HTTP ${response.status})`,
    );
  }

  const body: unknown = await response.json();
  if (!isObject(body) || !isString(body['access_token'])) {
    throw new Error(`Token endpoint for ${issuer} returned no \`access_token\``);
  }

  const token = body['access_token'];
  const expiresIn = body['expires_in'];
  // An issuer that reports no lifetime gets no cache entry rather than a
  // guessed one: serving a token past its expiry fails at the far end, where
  // the cause is hardest to see.
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
    tokens.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  }
  return token;
}
