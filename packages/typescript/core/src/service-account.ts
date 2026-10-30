/**
 * The client-credentials grant, for a process authenticating as ITSELF.
 *
 * A service or a worker holds its own account at the knowledge base's
 * issuer and exchanges that credential for a short-lived token. That token is
 * its bearer at the gateway, which names it by that account: an agent is an
 * account, as a person is.
 *
 * This replaced a single shared secret that every sidecar carried and that the
 * gateway compared by string equality. That secret granted any agent identity
 * to anyone holding it, and could only be rotated by restarting the stack.
 *
 * The token endpoint is discovered rather than constructed. Every issuer
 * publishes it; guessing a vendor's path would put that vendor's layout in
 * code that has no other reason to know it.
 */

import { HTTP_REQUEST_TIMEOUT_MS } from './generated/client-timing';
import { SignInError } from './sign-in-error';
import { isObject, isString } from './type-guards';
import { UnansweredError, jsonOf } from './unanswered';

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
      const unanswered = (error: unknown) => new UnansweredError(`OIDC discovery for ${issuer}`, error);
      const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS) }).catch((error: unknown) => {
        throw unanswered(error);
      });
      if (!response.ok) {
        throw new SignInError('discovery', `OIDC discovery for ${issuer} failed: HTTP ${response.status} from ${url}`, response.status);
      }
      const document = await jsonOf(response, unanswered);
      if (!isObject(document) || !isString(document['token_endpoint'])) {
        throw new SignInError('discovery', `OIDC discovery for ${issuer} returned no \`token_endpoint\``);
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
 * The service account's access token: the one held until it is due for
 * renewal, and a new grant after it, or at once when `renewed` (the gateway
 * refused the one held, or it is due by the holder's own schedule).
 *
 * Throws on refusal rather than returning null: a sidecar that cannot prove who
 * it is has nothing useful to do, and the caller's retry policy decides whether
 * this is worth attempting again. A refusal is a `SignInError` carrying the
 * status the issuer answered with; a request that got no answer is an
 * `UnansweredError`.
 *
 * Both requests, the issuer's discovery and the grant, are bounded by
 * `httpRequestTimeoutMs` (specs/src/client/timing.json): an issuer that
 * accepts a connection and never answers would otherwise hold a process's
 * start, and every renewal after it, for as long as the process lives.
 */
export async function serviceAccountToken(
  credential: ServiceAccountCredential,
  { renewed }: { renewed: boolean },
): Promise<string> {
  const { issuer, clientId, clientSecret } = credential;

  const key = `${issuer}\u0000${clientId}`;
  const cached = tokens.get(key);
  if (!renewed && cached && cached.expiresAt - RENEW_BEFORE_EXPIRY_MS > Date.now()) {
    return cached.token;
  }

  const endpoint = await tokenEndpoint(issuer);

  const unanswered = (error: unknown) => new UnansweredError(`Client-credentials grant for ${clientId} at ${issuer}`, error);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw unanswered(error);
  });

  if (!response.ok) {
    // The status, not the body: a token endpoint's error body can echo the
    // request, and this one carried a secret.
    throw new SignInError(
      'exchange',
      `Client-credentials grant for ${clientId} at ${issuer} failed (HTTP ${response.status})`,
      response.status,
    );
  }

  const body = await jsonOf(response, unanswered);
  if (!isObject(body) || !isString(body['access_token'])) {
    throw new SignInError('exchange', `Token endpoint for ${issuer} returned no \`access_token\``);
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
